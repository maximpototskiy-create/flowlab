# 🎨 Step 4.8 — Multimodal ImageGen + aspect/duration bug fix

## TL;DR

| Что | Раньше | Теперь |
|-----|--------|--------|
| Aspect 9:16 для Nano Banana | **Игнорировался** — генерировался 1:1 | Передаётся как `aspect_ratio` (15 вариантов) |
| Reference images в Nano Banana | Нет такой возможности | Подключаешь до 14 изображений на один multi-port |
| Reference images в Nano Banana Pro | Нет | До 14 на multi-port |
| Multimodal LLM (Claude/GPT/Gemini) | Принимал 1 изображение | Принимает много через один multi-port |
| Aspect в Kling V3 i2v | Сбивает с толку (не работает молча) | **Серый с подсказкой**: "наследуется от start image" |

## Что внутри

**6 файлов**:

```
src/lib/canvas/types.ts            ← Port.multi flag + helpers
src/lib/engine/executor.ts         ← resolveInputs собирает массивы
src/lib/engine/runners.ts          ← imageGen multimodal + aspect fix
src/lib/fal/client.ts              ← falLLM принимает массив URL
src/components/canvas/Canvas.tsx   ← edge-creation respects multi
src/components/canvas/CanvasNode.tsx ← толстый multi-port + counter badge + grey aspect
```

## Архитектура multimodal — как работает

### На канвасе
У Image Generation ноды теперь **два input-кружка**:
- `prompt` — обычный (узкая обводка, как раньше)
- `images` — multi-port: **толще, с внешним ring** и счётчиком "N" сверху-справа

Подключаешь сколько хочешь `image`-выходов в один `images` кружок — счётчик показывает сколько подключено. Все они складываются в массив.

### В runner

Если к Image Generation подключены reference images:

1. **Nano Banana 2** автоматически переключается на endpoint `fal-ai/nano-banana-2/edit` (поддерживает `image_urls[]` до 14)
2. **Nano Banana Pro** → `fal-ai/nano-banana-pro/edit`  
3. **Другие модели** (Flux/Imagen/Ideogram) — references **игнорируются** с warning в Vercel logs (чтобы не палить кредиты на 4xx-ошибку)

То есть user experience: подключаешь рефы → Nano Banana понимает; подключаешь к Flux → рефы игнорируются и не ломают вызов.

### TextGen multimodal

LLM-ноды (textGen, creativeBrief, imageAdPrompt, и т.д.) тоже получили multi-port `images`. `falLLM` теперь принимает массив URL и формирует OpenAI-формат с несколькими `image_url` content blocks. Claude/GPT/Gemini это поддерживают.

Старые workflow с `inputs.image` (single string) тоже работают — `collectImages()` тянет и из новой `images` array, и из legacy `image` ключа.

## Главный баг fix — aspect ratio для Nano Banana

Старый код (`runners.ts`):
```ts
if (model.includes("nano-banana")) {
  // Nano Banana 2 / Pro: prompt only (aspect controlled via prompt text)
  input.num_images = numResults;  // ← aspect_ratio НЕ передаётся!
}
```

Проверил fal.ai документацию: **Nano Banana 2 имеет `aspect_ratio` параметр**, 15 supported values (1:1, 16:9, 9:16, 4:5, 3:4, 2:3, 21:9, 1:4, 4:1, 8:1, 1:8, auto и др.). Просто никто не передавал.

Новый код передаёт. Теперь когда ты выставляешь 9:16 в UI — генерируется 9:16.

## Kling V3 aspect grey-out

fal.ai явно документирует: **"The `aspect_ratio` field in the UI is ignored by the model. Aspect ratio is determined by the start image."**

Сейчас в UI выставляешь aspect, картинка/видео генерируется не в том ratio, фрустрация. **Фикс**: когда выбрана `kling-video/v3/.../image-to-video` модель, aspect-селектор:
- становится **серым** (`opacity-50`, `cursor-not-allowed`)
- `<select>` actually `disabled`
- При hover показывает: *"Kling V3 inherits aspect from the start image — this field is ignored."*

Это honest UI: user сразу понимает почему его выбор aspect не применяется.

## Как накатить

1. Распакуй `flowlab-step4.8-multimodal-aspect.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"6 files will be updated"**
4. Commit: `Step 4.8: multimodal imageGen + aspect bug fix + Kling V3 aspect tooltip`
5. **Commit changes**
6. Ждём Vercel build

## Тесты

### 🔴 Тест #1 — aspect bug fix (главный, **проверь первым**)
1. Создай Image Generation, модель **Nano Banana 2**, aspect **9:16**, prompt "smartphone on table"
2. Run
3. ✅ Результат — портретная 9:16, **не** квадрат

### 🟢 Тест #2 — multimodal Nano Banana
1. Создай 2 Upload Image ноды → загрузи 2 изображения  
2. Создай Image Generation ноду (Nano Banana 2)
3. Соедини output обеих Upload Image → input `images` (толстый кружок) на Image Generation
4. ✅ На multi-port появляется badge "2"
5. Prompt: "combine these two scenes into one composition"
6. Run
7. ✅ В Vercel logs: модель будет `fal-ai/nano-banana-2/edit` (автопереключение)
8. ✅ Результат — реальная композиция из обоих референсов

### 🟢 Тест #3 — multimodal Text Generation
1. Upload Image нода → загрузи изображение  
2. Text Generation (Claude или GPT)
3. Соедини в input `images` (multi-port)
4. ✅ Badge "1"
5. Подключи ещё одно изображение → badge "2"
6. Prompt: "describe what's common in these two images"
7. ✅ Получишь анализ обоих

### 🟢 Тест #4 — Kling V3 grey-out
1. Создай Video Generation, выбери модель **Kling 3.0 Pro (I2V)**
2. ✅ Aspect-селектор серый, неактивный
3. Hover на него → tooltip: "Kling V3 inherits aspect from the start image..."
4. Если переключишь на Seedance или Veo → ✅ aspect снова активный

### 🟢 Тест #5 — back-compat
1. Открой старый workflow (с уже сохранёнными генерациями)
2. ✅ Всё рендерится как раньше, контент на месте
3. Запусти любую старую ноду — ✅ работает без рефов (multi-port пустой = массив `[]`)

## Что НЕ ломается

- Старые workflow продолжают работать (`collectImages()` поддерживает и старый `inputs.image`, и новый `inputs.images`)
- `falLLM` принимает и старый `string`, и новый `string[]` (overload)
- Поведение единичных портов не изменилось — multi-flag отдельный

## Технические заметки

### Почему multi-port реализован массивом, а не разделением на много кружков
Вариант "один кружок принимает много edges" → один порт = один массив значений = одно поле в runner-payload. Чисто, scales до N=14 без визуального шума, и сразу работает с тем что fal.ai требует (`image_urls[]` именно как массив, не как `image_url_1`, `image_url_2`).

### Почему дедуп по (fromNode, fromPort) на multi-port
Юзер может случайно дважды дернуть line от одной картинки на тот же multi-port. Дубликат бесполезен (это бы был тот же URL в массиве дважды) и стоил бы fal-кредитов. Защита в `addEdgeRespectingMulti` — silent skip duplicate.

### Что с aspect в Kling O3 / других моделях?
Проверил доку: **Kling O3** тоже наследует от start image, такая же история. Если ты часто используешь O3 — скажи, расширю grey-out условие на него тоже. Сейчас только V3 чтобы не overscale без подтверждения.

### Cost estimation
`/edit` варианты Nano Banana стоят примерно столько же сколько base — `estimateCost` matcher `"nano-banana"` работает и для `/edit` (includes match). Не пересчитываю.

## Что НЕ в патче (на потом)

- **Video-to-Video нода** (упомянуто ранее) — отдельный патч, нужно решить какой fal.ai endpoint лучше (Runway, Luma, Hailuo?)
- **Группировка нод** — UI feature, отдельная задача

После того как протестируешь — скажешь что приоритет, и поедем дальше.
