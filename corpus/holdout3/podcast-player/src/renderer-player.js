// Mini player window of Driftwood. It owns the <audio> element; the main process keeps the
// state that both windows show.

const CHAPTERS_ROOT = "https://api.driftwood.example/v1/episodes";
const VOLUME_KEY = "player.volume";

const audio = document.querySelector("audio");
const titleEl = document.querySelector("#title");
const artEl = document.querySelector("#art");
const chaptersEl = document.querySelector("#chapters");

let currentGuid = null;

async function loadChapters(guid) {
  const res = await fetch(`${CHAPTERS_ROOT}/${encodeURIComponent(guid)}/chapters`);
  if (!res.ok) return [];
  return (await res.json()).chapters;
}

async function showEpisode(episode) {
  currentGuid = episode.guid;
  titleEl.textContent = episode.title;
  audio.src = episode.audio;
  const art = await window.player.artwork(episode.showId);
  if (art) artEl.src = art;
  const chapters = await loadChapters(episode.guid);
  chaptersEl.replaceChildren(
    ...chapters.map((chapter) => {
      const button = document.createElement("button");
      button.textContent = chapter.title;
      button.onclick = () => window.player.seek(chapter.start);
      return button;
    }),
  );
}

function applyState(state) {
  if (state.episode && state.episode.guid !== currentGuid) showEpisode(state.episode);
  if (Math.abs(audio.currentTime - state.position) > 2) audio.currentTime = state.position;
  if (state.playing && audio.paused) audio.play();
  if (!state.playing && !audio.paused) audio.pause();
}

audio.volume = Number(localStorage.getItem(VOLUME_KEY) ?? "0.8");
audio.addEventListener("volumechange", () => localStorage.setItem(VOLUME_KEY, String(audio.volume)));
audio.addEventListener("ended", () => window.player.toggle());

document.querySelector("#toggle").addEventListener("click", () => window.player.toggle());
document.querySelector("#close").addEventListener("click", () => window.player.close());
document.addEventListener("keydown", (event) => {
  if (event.code === "Space") window.player.toggle();
  if (event.code === "ArrowRight") window.player.seek(audio.currentTime + 30);
  if (event.code === "ArrowLeft") window.player.seek(Math.max(0, audio.currentTime - 15));
});

window.player.onState(applyState);
window.player.ready();
window.player.nowPlaying().then((episode) => episode && showEpisode(episode));
