chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PLAY_OFFSCREEN_SOUND") {
    return false;
  }

  playBeep()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error("Failed to play offscreen sound", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function playBeep() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("Web Audio API is unavailable");
  }

  const context = new AudioContextClass();
  const gain = context.createGain();
  gain.gain.value = 0.16;
  gain.connect(context.destination);

  const notes = [
    { frequency: 880, duration: 0.16 },
    { frequency: 660, duration: 0.16 },
    { frequency: 880, duration: 0.22 }
  ];

  let cursor = context.currentTime;
  for (const note of notes) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    oscillator.connect(gain);
    oscillator.start(cursor);
    oscillator.stop(cursor + note.duration);
    cursor += note.duration + 0.03;
  }

  const totalDuration = cursor - context.currentTime + 0.05;
  await sleep(totalDuration * 1000);
  await context.close();
}

function sleep(timeoutMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, timeoutMs);
  });
}
