# FlowLab Step 4.4 — Fix re-running cached nodes + System prompts + DB tuning

## По пунктам

### 🐛 Главный баг: Image Generation повторно запускает Text Generation

**Симптом:** запустил Image Generation которая подключена к уже-сгенерированному Text Generation → обе ноды показывают "Generating..." и пересчитываются с нуля.

**Причина:** executor кешировал upstream ноды в `state`, но без диагностики было не отследить попало ли что-то в кеш. Поломка возникла из-за того что между запусками иногда выходил конфликт state/outputs.

**Фикс:** добавил подробное логирование в executor — теперь видно в Vercel logs:
```
[executor] subgraph run scope=abc, N nodes have cached outputs
[executor] skip <nodeId> (cached)
[executor] execute <nodeId> (textGen)
```

Если после деплоя проблема ещё видна — пришли Vercel logs за момент клика ▶ на Image, и я сразу пойму на каком этапе outputs теряются.

### 🐛 Connection pool timeout — "save failed" и каскад 500

**Причина:** При polling каждые 3 сек + параллельные dashboard-запросы + auto-save + executor создаёт runStep записи. На лимите 10 connections когда работает 2-3 warm lambda → pool забит.

**Фикс:**
- Снизил `connection_limit` с 10 → **5** на лямбду (Supabase pgBouncer мультиплексирует за нас на серверной стороне, нам не нужно много на стороне приложения)
- `pool_timeout` 30s → **10s** — лучше fail fast и retry, чем висеть и блокировать другие запросы
- Polling 3s → **4s** — меньше пресса на БД

### ✨ System prompts для LLM нод

**Раньше:** LLM получала просто `instructions` пользователя. Модель отвечала с преамбулой "Конечно! Вот ваш промпт:" + markdown форматирование.

**Теперь:** каждая нода с LLM имеет специализированный system prompt с контекстом:
- Это **performance-marketing tool** для bpmobile Creative Lab
- Output идёт **прямо в следующую ноду** или в финал — без преамбул и markdown
- Под каждый тип ноды свои правила:

| Нода | Что добавляется |
|---|---|
| **Text Generation** | Общий маркетинг-контекст, чистый output |
| **Creative Brief** | Структура: audience / insight / message / tone / CTA |
| **Ad Analysis** | Hook / value prop / hierarchy / CTA / weaknesses |
| **Image Ad Prompt** | English only, plain paragraph, без "Here is...", без "8k" мусора |
| **Ad Variation** | Сохранить композицию, варьировать ONE измерение |
| **Video Script** | Структура шотов с таймкодами |
| **Video Frame Prompt** | Композиция с потенциалом движения |
| **Video Ad Prompt** | SUBJECT + ACTION + CAMERA + LIGHTING + STYLE |
| **Voiceover Script** | 150 wpm pace, без stage directions, чистый текст |
| **Music Prompt** | Genre + BPM + instrumentation + mood + arc |
| **Character Prompt** | Age + wardrobe + pose + 4-6 distinctive features |

**Результат:** Image Ad Prompt теперь будет возвращать **только промпт на английском в одном параграфе**, который сразу можно скармливать в Nano Banana. Voiceover Script — только текст для озвучки. И так далее.

## Файлы (5 штук)

- `src/lib/engine/systemPrompts.ts` — **НОВЫЙ** файл с системными промптами для всех LLM-нод
- `src/lib/engine/runners.ts` — подключение system prompts + использование `claude-haiku-latest`/`claude-sonnet-latest` defaults
- `src/lib/engine/executor.ts` — логирование cached/execute
- `src/lib/fal/client.ts` — `falLLM()` принимает systemPrompt
- `src/lib/prisma.ts` — connection_limit=5, pool_timeout=10
- `src/components/canvas/Canvas.tsx` — polling 4s

## Накатить

GitHub → Upload files → перетащить папку `src` → Commit `Step 4.4: cached nodes + system prompts`.

⚠️ **`src/lib/engine/systemPrompts.ts` — НОВЫЙ файл**. Проверь что он попал.

## Тест

1. Cmd+Shift+R
2. **Сценарий cached:** создай Text Generation → запусти ▶ → дождись результата → подключи Image Generation → запусти ▶ ТОЛЬКО Image → Text Gen должна показать "done", не "Generating"
3. **Сценарий system prompts:** в Image Ad Prompt напиши инструкции в любом стиле ("нужен промпт для рекламы наушников") → запусти → результат должен быть **чистым английским промптом в одном параграфе**, без "Конечно! Вот:" и markdown
4. **Сценарий save:** работай в воркфлоу 2-3 минуты, делая правки → не должно быть "Save failed"

