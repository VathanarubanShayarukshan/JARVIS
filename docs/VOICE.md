# Voice chat (walkie-talkie mode)

JARVIS has a built-in **voice chat mode** — no microphone app needed, it
uses your browser's mic and speaker (Web Speech API).

## How it works

1. Click the 🎤 button in the top bar (it lights up; pick your language
   English / English-IN / Tamil / Hindi in the dropdown next to it).
2. **Speak.** The mic listens and shows your words live near the composer.
3. End your turn by saying **".over"** — the mic stops instantly and the
   message is sent to the agent.
4. **Agent's turn:** the reply is spoken out loud and ends with the word
   **"over"**. While it speaks the mic is OFF, so the speaker output is never
   recorded and stray noise can't disturb the chat.
5. After "over", the mic turns back on and you can speak your next turn.

This is deliberately **half-duplex** (like a walkie-talkie): mic on only
while you talk, off while the agent talks. Anything you say after your
".over" and before the agent finishes saying its own "over" is ignored.

## Notes

- The status pill next to the composer shows what is happening:
  **Listening…** (green/yellow) vs **Agent speaking…** (green).
- Say **"over"** by itself at any moment to interrupt and send nothing.
- Clicking 🎤 again turns voice mode off (also stops any speaking). Typing
  still works while voice mode is on.
- Voice mode speaks every normal agent reply; error messages are spoken too
  (as "Error: …" then "over") so the loop never gets stuck.
- If the browser blocks the mic, the status pill tells you to allow the
  permission (Chrome/Edge/Firefox all support this; Safari needs macOS 14+).
- Recognition accuracy depends on the browser + language — Tamil (`ta-IN`)
  works in Chrome on Android/Windows and Edge.

## Privacy

All speech recognition and text-to-speech happen **in your browser**, not on
the server — nothing is uploaded, nothing is stored.