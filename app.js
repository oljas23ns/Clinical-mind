const API = "/api";

let authToken = localStorage.getItem(
  "clinical_mind_token"
);

let currentSessionId =
  localStorage.getItem(
    "clinical_mind_session"
  );

let currentCase = null;

const $ = id =>
  document.getElementById(id);

function show(id) {
  $(id).classList.remove("hidden");
}

function hide(id) {
  $(id).classList.add("hidden");
}

async function apiRequest(
  endpoint,
  options = {}
) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (authToken) {
    headers.Authorization =
      `Bearer ${authToken}`;
  }

  const response = await fetch(
    `${API}${endpoint}`,
    {
      ...options,
      headers
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Request failed"
    );
  }

  return data;
}

async function login() {
  const username =
    $("username").value.trim();

  const password =
    $("password").value;

  $("authError").textContent = "";

  try {
    const data = await apiRequest(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          username,
          password
        })
      }
    );

    authToken = data.token;

    localStorage.setItem(
      "clinical_mind_token",
      authToken
    );

    await showCases();
  } catch (error) {
    $("authError").textContent =
      error.message;
  }
}

async function register() {
  const username =
    $("username").value.trim();

  const password =
    $("password").value;

  $("authError").textContent = "";

  try {
    const data = await apiRequest(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({
          username,
          password
        })
      }
    );

    authToken = data.token;

    localStorage.setItem(
      "clinical_mind_token",
      authToken
    );

    await showCases();
  } catch (error) {
    $("authError").textContent =
      error.message;
  }
}

async function showCases() {
  hide("authScreen");
  hide("gameScreen");
  show("caseScreen");
  show("logoutButton");

  const [
    cases,
    progress
  ] = await Promise.all([
    apiRequest("/cases"),
    apiRequest("/progress")
  ]);

  $("progressText").textContent =
    `Өтілген: ${progress.cases_completed} | ` +
    `Жалпы балл: ${progress.total_score}`;

  const list =
    $("casesList");

  list.innerHTML = "";

  cases.forEach(item => {
    const card =
      document.createElement("div");

    card.className =
      "card case-card";

    card.innerHTML = `
      <span class="badge">
        ${item.difficulty || "Орташа"}
      </span>

      <h2>${escapeHtml(item.title)}</h2>

      <p class="muted">
        ${escapeHtml(item.patient.name)},
        ${item.patient.age} жас,
        ${escapeHtml(item.patient.gender)}
      </p>

      <p>
        ${escapeHtml(item.patient.complaint)}
      </p>

      <button>
        Кейсті бастау →
      </button>
    `;

    card
      .querySelector("button")
      .addEventListener(
        "click",
        () => startGame(item.id)
      );

    list.appendChild(card);
  });
}

async function startGame(caseId) {
  try {
    const data =
      await apiRequest(
        "/game/start",
        {
          method: "POST",
          body: JSON.stringify({
            caseId
          })
        }
      );

    currentSessionId =
      data.sessionId;

    localStorage.setItem(
      "clinical_mind_session",
      currentSessionId
    );

    currentCase =
      data.case;

    renderGame(
      data.case,
      0
    );

    await loadFullSession();

  } catch (error) {
    alert(error.message);
  }
}

async function loadFullSession() {
  if (!currentSessionId) {
    return;
  }

  try {
    const session =
      await apiRequest(
        `/game/${currentSessionId}`
      );

    currentCase =
      session.case;

    renderGame(
      session.case,
      session.score
    );

    if (session.status === "completed") {
      showCompletedState(
        session.score
      );
    }
  } catch {
    localStorage.removeItem(
      "clinical_mind_session"
    );

    currentSessionId = null;
  }
}

function renderGame(
  clinicalCase,
  score
) {
  hide("authScreen");
  hide("caseScreen");
  show("gameScreen");
  show("logoutButton");

  $("caseTitle").textContent =
    clinicalCase.title;

  $("difficulty").textContent =
    clinicalCase.difficulty || "";

  $("score").textContent =
    score;

  $("patientName").textContent =
    clinicalCase.patient.name;

  $("patientAge").textContent =
    clinicalCase.patient.age;

  $("patientGender").textContent =
    clinicalCase.patient.gender;

  $("bp").textContent =
    clinicalCase.vitals.blood_pressure;

  $("hr").textContent =
    clinicalCase.vitals.heart_rate;

  $("spo2").textContent =
    `${clinicalCase.vitals.spo2}%`;

  $("temperature").textContent =
    `${clinicalCase.vitals.temperature}°C`;

  $("complaint").textContent =
    clinicalCase.patient.complaint;

  renderExaminations(
    clinicalCase.examinations
  );

  renderOptions(
    clinicalCase.options
  );
}

function renderExaminations(
  examinations
) {
  const container =
    $("examinations");

  container.innerHTML = "";

  examinations.forEach(exam => {
    const card =
      document.createElement("div");

    card.className = "exam";

    card.innerHTML = `
      <h3>${escapeHtml(exam.name)}</h3>

      <button>
        Тексеру
      </button>

      <div class="result hidden"></div>
    `;

    const button =
      card.querySelector("button");

    const result =
      card.querySelector(".result");

    button.addEventListener(
      "click",
      async () => {
        button.disabled = true;

        try {
          const data =
            await apiRequest(
              `/game/${currentSessionId}/action`,
              {
                method: "POST",
                body: JSON.stringify({
                  type: "examination",
                  examinationId:
                    exam.id
                })
              }
            );

          $("score").textContent =
            data.score;

          result.textContent =
            data.actionResult.result;

          showElement(result);

        } catch (error) {
          button.disabled = false;
          alert(error.message);
        }
      }
    );

    container.appendChild(card);
  });
}

function renderOptions(
  options
) {
  const container =
    $("options");

  container.innerHTML = "";

  options.forEach(option => {
    const button =
      document.createElement("button");

    button.className =
      "option";

    button.textContent =
      option;

    button.addEventListener(
      "click",
      () => submitDiagnosis(option)
    );

    container.appendChild(button);
  });
}

async function submitDiagnosis(
  answer
) {
  const buttons =
    document.querySelectorAll(
      "#options button"
    );

  buttons.forEach(
    button => {
      button.disabled = true;
    }
  );

  try {
    const data =
      await apiRequest(
        `/game/${currentSessionId}/action`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "diagnosis",
            answer
          })
        }
      );

    $("score").textContent =
      data.score;

    showCompletedState(
      data.score,
      data.actionResult
    );

  } catch (error) {
    buttons.forEach(
      button => {
        button.disabled = false;
      }
    );

    alert(error.message);
  }
}

function showCompletedState(
  score,
  result = null
) {
  const feedback =
    $("gameFeedback");

  feedback.classList.remove(
    "hidden"
  );

  if (result) {
    feedback.innerHTML = `
      <h3>
        ${
          result.correct
            ? "✅ Дұрыс диагноз!"
            : "❌ Қате диагноз"
        }
      </h3>

      <p>
        <strong>Дұрыс жауап:</strong>
        ${escapeHtml(
          result.correctAnswer
        )}
      </p>

      <p>
        ${escapeHtml(
          result.feedback || ""
        )}
      </p>

      <h3>
        Қорытынды ұпай: ${score}
      </h3>
    `;
  } else {
    feedback.innerHTML = `
      <h3>Бұл кейс аяқталған.</h3>
      <h3>Ұпай: ${score}</h3>
    `;
  }
}

function showElement(element) {
  element.classList.remove(
    "hidden"
  );
}

function logout() {
  authToken = null;
  currentSessionId = null;
  currentCase = null;

  localStorage.removeItem(
    "clinical_mind_token"
  );

  localStorage.removeItem(
    "clinical_mind_session"
  );

  hide("caseScreen");
  hide("gameScreen");
  hide("logoutButton");
  show("authScreen");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("loginButton")
  .addEventListener(
    "click",
    login
  );

$("registerButton")
  .addEventListener(
    "click",
    register
  );

$("logoutButton")
  .addEventListener(
    "click",
    logout
  );

$("backToCases")
  .addEventListener(
    "click",
    showCases
  );

if (authToken) {
  showCases().catch(() => {
    logout();
  });
}