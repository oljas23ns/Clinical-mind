require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

function createToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  const token = header.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.userId,
      username: decoded.username
    };

    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired token"
    });
  }
}

async function initializeDatabase() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  await pool.query(schema);
  console.log("Database schema is ready");
}

async function initializeCases() {
  const filePath = path.join(__dirname, "cases.json");
  const cases = JSON.parse(fs.readFileSync(filePath, "utf8"));

  for (const clinicalCase of cases) {
    await pool.query(
      `
      INSERT INTO clinical_cases (id, title, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (id)
      DO UPDATE SET
        title = EXCLUDED.title,
        data = EXCLUDED.data
      `,
      [
        clinicalCase.id,
        clinicalCase.title,
        JSON.stringify(clinicalCase)
      ]
    );
  }

  console.log(`Loaded ${cases.length} clinical cases`);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required"
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        error: "Username must contain at least 3 characters"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must contain at least 6 characters"
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users (username, password_hash)
      VALUES ($1, $2)
      RETURNING id, username
      `,
      [username, passwordHash]
    );

    const user = result.rows[0];

    await pool.query(
      `
      INSERT INTO user_progress (user_id)
      VALUES ($1)
      `,
      [user.id]
    );

    const token = createToken(user);

    res.status(201).json({
      token,
      user
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      `
      SELECT id, username, password_hash
      FROM users
      WHERE username = $1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const token = createToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login failed"
    });
  }
});

app.get("/api/cases", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        title,
        data->'patient' AS patient,
        data->>'difficulty' AS difficulty
      FROM clinical_cases
      ORDER BY id
      `
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load cases"
    });
  }
});

app.post("/api/game/start", authMiddleware, async (req, res) => {
  try {
    const { caseId } = req.body;

    const caseResult = await pool.query(
      `
      SELECT id, title, data
      FROM clinical_cases
      WHERE id = $1
      `,
      [caseId]
    );

    if (caseResult.rows.length === 0) {
      return res.status(404).json({
        error: "Case not found"
      });
    }

    const sessionId = crypto.randomUUID();

    await pool.query(
      `
      INSERT INTO game_sessions
      (
        id,
        user_id,
        case_id,
        score,
        current_step,
        answers,
        state,
        status
      )
      VALUES
      ($1, $2, $3, 0, 0, '[]'::jsonb, '{}'::jsonb, 'active')
      `,
      [
        sessionId,
        req.user.id,
        caseId
      ]
    );

    const clinicalCase = caseResult.rows[0].data;

    res.json({
      sessionId,
      case: {
        id: clinicalCase.id,
        title: clinicalCase.title,
        difficulty: clinicalCase.difficulty,
        patient: clinicalCase.patient,
        vitals: clinicalCase.vitals,
        examinations: clinicalCase.examinations,
        options: clinicalCase.options
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not start game"
    });
  }
});

app.get(
  "/api/game/:sessionId",
  authMiddleware,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          gs.*,
          cc.data AS case_data
        FROM game_sessions gs
        JOIN clinical_cases cc
          ON cc.id = gs.case_id
        WHERE gs.id = $1
          AND gs.user_id = $2
        `,
        [
          req.params.sessionId,
          req.user.id
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Game session not found"
        });
      }

      const session = result.rows[0];

      res.json({
        sessionId: session.id,
        score: session.score,
        currentStep: session.current_step,
        answers: session.answers,
        state: session.state,
        status: session.status,
        case: session.case_data
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not load session"
      });
    }
  }
);

app.post(
  "/api/game/:sessionId/action",
  authMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { type, examinationId, answer } = req.body;

      await client.query("BEGIN");

      const sessionResult = await client.query(
        `
        SELECT
          gs.*,
          cc.data AS case_data
        FROM game_sessions gs
        JOIN clinical_cases cc
          ON cc.id = gs.case_id
        WHERE gs.id = $1
          AND gs.user_id = $2
        FOR UPDATE
        `,
        [
          req.params.sessionId,
          req.user.id
        ]
      );

      if (sessionResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Session not found"
        });
      }

      const session = sessionResult.rows[0];

      if (session.status !== "active") {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "Game session is already finished"
        });
      }

      const clinicalCase = session.case_data;

      let scoreChange = 0;
      let feedback = "";
      let actionResult = null;

      const answers = Array.isArray(session.answers)
        ? session.answers
        : [];

      if (type === "examination") {
        const examination = clinicalCase.examinations.find(
          item => item.id === examinationId
        );

        if (!examination) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            error: "Examination not found"
          });
        }

        const alreadyDone = answers.some(
          item =>
            item.type === "examination" &&
            item.examinationId === examinationId
        );

        if (!alreadyDone) {
          scoreChange = clinicalCase.examination_points || 5;

          answers.push({
            type: "examination",
            examinationId,
            result: examination.result,
            points: scoreChange,
            timestamp: new Date().toISOString()
          });
        }

        actionResult = {
          examination: examination.name,
          result: examination.result
        };
      }

      if (type === "diagnosis") {
        if (!answer) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error: "Diagnosis answer is required"
          });
        }

        const alreadyAnswered = answers.some(
          item => item.type === "diagnosis"
        );

        if (!alreadyAnswered) {
          const correct =
            answer === clinicalCase.correct_answer;

          scoreChange = correct
            ? clinicalCase.diagnosis_points || 15
            : -5;

          feedback = correct
            ? clinicalCase.feedback
            : `Дұрыс жауап: ${clinicalCase.correct_answer}. ${clinicalCase.feedback}`;

          answers.push({
            type: "diagnosis",
            answer,
            correct,
            points: scoreChange,
            timestamp: new Date().toISOString()
          });
        }

        actionResult = {
          correct:
            answer === clinicalCase.correct_answer,
          correctAnswer: clinicalCase.correct_answer,
          feedback
        };
      }

      const newScore = Math.max(
        0,
        session.score + scoreChange
      );

      const newStep = session.current_step + 1;

      const isFinished = type === "diagnosis";

      await client.query(
        `
        UPDATE game_sessions
        SET
          score = $1,
          current_step = $2,
          answers = $3,
          updated_at = CURRENT_TIMESTAMP,
          status = $4::varchar,
          finished_at = CASE
            WHEN $4::varchar = 'completed'
            THEN CURRENT_TIMESTAMP
            ELSE finished_at
          END
        WHERE id = $5
          AND user_id = $6
        `,
        [
          newScore,
          newStep,
          JSON.stringify(answers),
          isFinished ? "completed" : "active",
          req.params.sessionId,
          req.user.id
        ]
      );

      if (isFinished) {
        await client.query(
          `
          INSERT INTO user_progress
          (
            user_id,
            cases_completed,
            total_score,
            best_score
          )
          VALUES ($1, 1, $2, $2)
          ON CONFLICT (user_id)
          DO UPDATE SET
            cases_completed =
              user_progress.cases_completed + 1,
            total_score =
              user_progress.total_score + $2,
            best_score =
              GREATEST(user_progress.best_score, $2),
            updated_at =
              CURRENT_TIMESTAMP
          `,
          [
            req.user.id,
            newScore
          ]
        );
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        score: newScore,
        scoreChange,
        currentStep: newStep,
        status: isFinished
          ? "completed"
          : "active",
        actionResult
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error(error);

      res.status(500).json({
        error: "Could not process action"
      });
    } finally {
      client.release();
    }
  }
);

app.post(
  "/api/progress/save",
  authMiddleware,
  async (req, res) => {
    try {
      const {
        sessionId,
        state
      } = req.body;

      const result = await pool.query(
        `
        UPDATE game_sessions
        SET
          state = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
          AND user_id = $3
        RETURNING id, state
        `,
        [
          JSON.stringify(state || {}),
          sessionId,
          req.user.id
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Session not found"
        });
      }

      res.json({
        success: true,
        session: result.rows[0]
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not save progress"
      });
    }
  }
);

app.get(
  "/api/progress",
  authMiddleware,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          cases_completed,
          total_score,
          best_score,
          updated_at
        FROM user_progress
        WHERE user_id = $1
        `,
        [req.user.id]
      );

      res.json(
        result.rows[0] || {
          cases_completed: 0,
          total_score: 0,
          best_score: 0
        }
      );
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not load progress"
      });
    }
  }
);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      application: "CLINICAL MIND"
    });
  } catch {
    res.status(500).json({
      status: "database_error"
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function startServer() {
  try {
    await pool.query("SELECT 1");
    await initializeDatabase();
    await initializeCases();

    app.listen(PORT, () => {
      console.log(
        `CLINICAL MIND running at http://localhost:${3000}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();