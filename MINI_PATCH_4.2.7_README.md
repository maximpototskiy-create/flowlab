# FlowLab Step 4.2.7 — Real model IDs + Dashboard fix

## Извинения за 4.2.5 и 4.2.6

Я несколько раз пытался обойти проблему вместо того чтобы **проверить реальную документацию fal.ai**. Сейчас я внимательно изучил все актуальные endpoints для image, video, audio, LLM и обновил ВСЁ за один проход. Больше тыканья вслепую не будет.

## Что починено

### 🐛 Dashboard упал после 4.2.3
`connection_limit=1` в Prisma не давал dashboard выполнить 6+ параллельных count/findMany запросов — все упирались в 1 соединение и таймаутили. **Увеличил до 10** — pgBouncer transaction pool сам мультиплексирует, и это безопасно.

### 🐛 Главная причина 422 на LLM
- `fal-ai/any-llm` **deprecated** (написано прямо на странице модели).
- Реальный endpoint — `openrouter/router` через **OpenAI-compatible API** на `https://fal.run/openrouter/router/openai/v1`.
- Модели на OpenRouter называются через **точку**, не дефис:
  - ❌ `claude-opus-4-7` → ✅ `claude-opus-4.7`
  - ❌ `claude-haiku-4-5` → ✅ `claude-haiku-latest`
  - ❌ `claude-sonnet-4-6` → ✅ `claude-sonnet-latest`
  - ❌ `gpt-5.5` (не существует) → ✅ `gpt-5.1`
  - ❌ `gemini-3.1-pro` → ✅ `gemini-3-pro-preview`
  - ❌ `deepseek-v4-pro` → ✅ `deepseek-v3.2`

### 🐛 Видео модели — неправильные ID
- ❌ `fal-ai/kling-video/v3/master/image-to-video` (не существует) → ✅ `v3/pro/image-to-video`
- ❌ `fal-ai/kling-video/v3-omni` (не существует) → удалил
- ❌ `fal-ai/kling-video/v2.6/master` → ✅ `v2.1/master` (v2.6 на fal нет)
- ❌ `fal-ai/bytedance/seedance/v2-pro/image-to-video` → ✅ `bytedance/seedance-2.0/image-to-video`
- Добавил Veo 3.1 First-Last-Frame для I2V с start+end кадрами

### 🐛 Поля для видео разные у разных моделей
Я унифицировал но реально каждое семейство своё:
- **Kling**: `image_url` (start) + `tail_image_url` (end) + `reference_image_url`
- **Seedance**: `image_url` (start) + `end_image_url` + `resolution: "720p"` + `generate_audio`
- **Veo**: `image_url` (first) + `last_image_url` + `generate_audio`

Runner теперь делает правильный payload в зависимости от семейства модели.

### 🐛 Nano Banana 2 принимает другие поля
- ❌ `image_size: "square_hd"` (не принимает) → ✅ только `prompt` + `num_images`
- Для **edit endpoint** (nano-banana-2/edit) — `image_urls: [...]` массив, не `image_url`

### 🐛 ElevenLabs SFX endpoint deprecated
- ❌ `fal-ai/elevenlabs/sound-effects` → ✅ `fal-ai/elevenlabs/sound-effects/v2`
- Добавил `tts/eleven-v3` (новейший TTS) и `tts/turbo-v2.5` (быстрый) как опции

## Файлы (4 штуки)

- `src/lib/prisma.ts` — connection_limit=10 (был 1, dashboard падал)
- `src/lib/fal/client.ts` — `falLLM()` через `openrouter/router`
- `src/lib/canvas/types.ts` — все model IDs реальные
- `src/lib/engine/runners.ts` — per-family payload mapping для video, image, edit

## Накатить

GitHub → Upload files → перетащить папку `src` из архива → Commit `Real fal.ai model IDs + fix dashboard`.

## Тест после деплоя

1. **Cmd+Shift+R**
2. Dashboard должен открываться (раньше падал в 4.2.6)
3. ▶ Text Generation с Claude Opus 4.7 → текст за 10-20с
4. ▶ Image Generation с Nano Banana 2 → картинка за 20-40с
5. ▶ Video Generation Kling 3.0 Pro с image-to-video и start_frame подключённым → видео за 1-3 мин

Если какая-то конкретная модель всё ещё 422 — fal.ai могла её недавно убрать. Скажи какая именно — заменю.

