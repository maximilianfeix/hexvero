const flasher = window.flasher;
const params = new URLSearchParams(window.location.search);
const deviceId = params.get("device");
const GUIDE_TEXT = "Do not unplug the pad. Help: https://docs.padwright.example/guides/flashing";

const stageLabel = { Erase: "Erasing", Write: "Writing", Verify: "Verifying", Done: "Done" };

function show(progress) {
  document.querySelector("#stage").textContent = stageLabel[progress.stage] ?? progress.stage;
  document.querySelector("#bar").value = progress.percent;
  if (progress.stage === "Done") sessionStorage.removeItem("flasher.inProgress");
}

async function begin() {
  const version = document.querySelector("#version").value;
  sessionStorage.setItem("flasher.inProgress", JSON.stringify({ deviceId, version }));
  const result = await flasher.start(deviceId, "pad-12", version);
  document.querySelector("#result").textContent = `${result.bytes} bytes written`;
}

window.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#guide").textContent = GUIDE_TEXT;
  flasher.onProgress(show);
  document.querySelector("#start").addEventListener("click", begin);
  document.querySelector("#cancel").addEventListener("click", () => flasher.cancel(deviceId));
  const interrupted = sessionStorage.getItem("flasher.inProgress");
  if (interrupted) document.querySelector("#warning").hidden = false;
});
