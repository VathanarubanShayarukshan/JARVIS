# TinyAI — Answerable Prompts

TinyAI is the built-in, zero-install, no-network, no-key local model inside
JARVIS. It answers everyday phrases in **English and Tamil** and does simple
math. Below is the full list of what it can answer (and what it cannot).

## What TinyAI CAN answer

### Greetings (English)
| Prompt | Response |
| --- | --- |
| hi / hello / hey / yo / hai | "I am TinyAI — the built-in, no-install mini model…" |
| good morning / good afternoon / good evening / good night | greeting + "How can I help?" |

### Greetings (Tamil)
| Prompt | Response |
| --- | --- |
| வணக்கம் / ஹலோ | "வணக்கம்! நான் TinyAI — இந்த சர்வரின் உள்ளமைந்த லைட் மாடல்…" |

### How are you
| Prompt | Response |
| --- | --- |
| how are you / how r u / how are u / whats up / what's up | "I am doing great! How about you?" |
| எப்படி / எப்படியிருக்க / சுகமா | "நான் நன்றாக இருக்கிறேன்! நீங்கள் எப்படி இருக்கிறீர்கள்?" |

### Who are you
| Prompt | Response |
| --- | --- |
| who are you / what are you / about you / tell me about yourself | TinyAI self-introduction |
| யார் நீ / நீ யார் / உன்னை | "நான் TinyAI — இந்த JARVIS சர்வரின் உள்ளமைந்த சிறிய மாடல்…" |

### Help / capabilities
| Prompt | Response |
| --- | --- |
| help / what can you do / what do you do / commands / abilities / can you help | Capabilities list (greetings, math, time/date) |
| உதவி / செய்ய | Tamil capabilities list |

### Thanks
| Prompt | Response |
| --- | --- |
| thanks / thank you / thx / ty | "You are welcome!" |
| நன்றி / நன்றிகள் / தாங்க்ஸ் | "நன்றி! உங்களுக்கு வேறு உதவி தேவையா?" |

### Bye
| Prompt | Response |
| --- | --- |
| bye / goodbye / see you / see u / good night | "Bye! Talk again soon." |
| குட்பை / போய் வருகிறேன் | "நன்றி! மீண்டும் பேசுவோம்." |

### Simple math (any arithmetic expression)
| Prompt | Response |
| --- | --- |
| 12 * 8 | 12 * 8 = 96 |
| (45 + 15) / 3 | (45 + 15) / 3 = 20 |
| 17 % 5 | 17 % 5 = 2 |
| 100 / 3 | 100 / 3 = 33.3333 |
| 2 ** 10 | 2 ** 10 = 1024 |
| (99 - 7) * 2 | (99 - 7) * 2 = 184 |

**Rules:** only digits, operators (+ - * / % **), parentheses, spaces, and dots.
No letters, no variables, no function calls.

### Time / date
| Prompt | Response |
| --- | --- |
| what time is it | "It is 08:45 PM on Wednesday, 19 August 2026." |
| what's the date | same format |
| நேரம் / தேதி | Tamil time/date |

## What TinyAI CANNOT answer

Anything that requires reasoning, knowledge, code, internet, or file access:
- "write me a poem" → fallback: "That is beyond my tiny brain…"
- "what is the capital of France" → fallback
- "summarize this file" → fallback
- "create a to-do app" → fallback
- Any shell command / tool use → TinyAI has no tools

**For real work, pick a cloud provider (Gemini / Groq / OpenCode Zen) or Ollama.**
