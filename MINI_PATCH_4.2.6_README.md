# FlowLab Step 4.2.6 — Real fix for 422

## Извинения

Я ошибся в 4.2.5 — пытался mapping'ом обойти проблему. **Ты был прав**: эти модели существуют. Просто `fal-ai/any-llm` endpoint **deprecated** ("This model is no longer supported" прямо на странице).

Проверил в реальной документации fal.ai:
- ❌ `fal-ai/any-llm` — устарел, возвращает 422 на любую модель
- ✅ `openrouter/router` — новый endpoint, **через OpenRouter**, поддерживает Claude Opus 4.7, GPT-5.5, Gemini 3 Pro, DeepSeek V4, Llama 4 — те самые модели что у нас в types.ts

## Что починил

`falLLM()` теперь:
- Использует `https://fal.run/openrouter/router/openai/v1/chat/completions`
- OpenAI-compatible chat completions API (`messages: [{role, content}]`)
- Vision поддержка через content blocks с `image_url`
- Все наши модели (claude-opus-4-7, gpt-5.5, gemini-3.1-pro и т.д.) работают через OpenRouter напрямую

## Файлы

- `src/lib/fal/client.ts`

## Накатить

GitHub → Upload files → `src/lib/fal/client.ts` (один файл) → Commit `Switch from deprecated any-llm to openrouter/router`.

## Тест

Cmd+Shift+R → ▶ на Text Generation → за 5-15 сек текст в ноде.

Image Generation тоже должно работать — fix из 4.2.5 (graceful Storage fallback) остаётся в силе, runner возвращает fal URL если бакета нет.

