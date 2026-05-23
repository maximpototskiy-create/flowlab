# 🛠️ Step 4.9 + 4.10 — Quick wins + UX overhaul

**6 файлов** (5 правленых + 1 новый `Lightbox.tsx`).

## Сводка

### 🐛 Баги (4.9)

| # | Что было | Что стало |
|---|---|---|
| **1** | Nano Banana 2: выбираешь num=4 → генерится 1 (silent override) | `limit_generations: false` → честные 4 картинки |
| **2** | LLM отвечает "Вот 4 промпта..." с заголовками **КОНЦЕПТ 1**, `---` | Усиленный system prompt + format reminder в каждом сообщении → чистый деливерабл |
| **6** | Соединил TextGen → ImageGen, но в input ноды промпт не виден до запуска | Над textarea появляется превью "← context" с реальным текстом + Copy кнопка |

### 🎨 UX (4.10)

| # | Что было | Что стало |
|---|---|---|
| **3** | Текст обрезался на 500 chars в ноде, 400 в expanded modal | Полный текст + scroll до 280px (нода) и 60vh (modal) + Copy на hover |
| **4** | Ноды не растягиваются | Resize handle в правом нижнем углу — drag вниз чтобы увеличить height |
| **5** | Картинки/видео нельзя посмотреть в полном размере | Hover → кнопка "Expand" → fullscreen Lightbox (Esc / клик вне закрывают, есть Download) |
| **7 (часть)** | Scroll всегда был pan, переключить нельзя | Toggle в zoom-toolbar: Hand 🖐️ = pan-mode (Cmd+scroll zoom), Cursor 🖱️ = zoom-mode (Shift+scroll pan), сохраняется в localStorage |

## Что отложено на следующий патч

| Запрос | Когда |
|---|---|
| **#7** organize nodes (auto-layout) | Следующий патч — нужен dagre или собственный layout |
| **#7** minimap | Можно сразу — небольшой компонент |
| **#8** multi-select + group nodes | Следующий патч — серьёзная UX работа |

## Как накатить

1. Распакуй `flowlab-step4.9-4.10-quick-wins-ux.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"5 files will be updated, 1 file will be added"** (Lightbox.tsx — новый)
4. Commit: `Step 4.9 + 4.10: bugs + UX (lightbox, resize, scroll-mode, copy)`
5. **Commit changes** → Vercel build

Type-check проходит чисто, проверял локально на полном проекте.

## Тесты

### 🔴 Тест #1 — num_images наконец-то работает
1. Image Generation → Nano Banana 2 → aspect 9:16 → **num_results = 4**
2. Run
3. ✅ Получаешь **4 картинки** (раньше всегда было 1)
4. Внизу ноды появляется carousel "1 of 4" — листай thumbnails

### 🟡 Тест #2 — LLM без преамбулы
1. Text Generation (Claude Opus 4.7)
2. Instructions: "напиши промпт для nano banana 2, чтобы сделать 4 разных концепта баннеров для cleaner kit"
3. Run
4. ✅ Ответ начинается **прямо с первого концепта**, без "Вот 4 промпта...", без `---`, без `**КОНЦЕПТ 1**`
5. Если генерируется несколько промптов — они разделены **только одной пустой строкой**

⚠️ Полностью гарантировать что любая модель в любой ситуации не выкинет преамбулу нельзя — но я усилил инструкции до максимума: и в system prompt, и в самом user сообщении внизу есть напоминание. Если всё равно увидишь преамбулу — пришли скрин с моделью + полным prompt, ещё подкручу.

### 🟢 Тест #3 — Resolved input preview
1. Text Generation → запусти → получи текст
2. Создай Image Generation
3. Соедини output(text) TextGen'а → input(prompt) ImageGen
4. ✅ В ImageGen ноде **над** полем INSTRUCTIONS появляется голубой блок:
   ```
   ← prompt              Copy
   [полный текст из TextGen]
   ```
5. Жми Run у ImageGen — она использует и upstream text, и поле INSTRUCTIONS (если оба заполнены)

### 🟢 Тест #4 — Полный текст
1. Text Generation → сгенерируй длинный промпт (>500 символов)
2. ✅ В ноде видишь весь текст со scroll внутри (раньше обрезалось `…`)
3. Hover на текст → появляется кнопка **Copy** в правом верхнем углу
4. Клик Copy → текст в буфере, можно проверить Cmd+V в другом месте

### 🟢 Тест #5 — Resize ноды
1. Любая нода → правый нижний угол → видишь маленький треугольник
2. Drag вниз → нода растёт по высоте
3. F5 (refresh страницы)
4. ✅ Размер сохраняется (через `node.config._height`)

### 🟢 Тест #6 — Lightbox
1. Сгенерируй картинку в Image Generation
2. Hover на превью → правый верх → кнопка **Expand**
3. Клик → fullscreen viewer
4. ✅ Картинка в полный размер, Esc закрывает, клик вне закрывает, кнопка Download качает файл
5. То же самое для видео — играется автоматически, есть controls

### 🟢 Тест #7 — Scroll mode toggle
1. Bottom zoom-toolbar → крайняя правая кнопка (Hand 🖐️ или Cursor 🖱️)
2. По умолчанию — Hand (pan-mode):
   - Two-finger scroll / wheel → панорама канваса
   - Cmd/Ctrl + scroll → zoom
3. Клик на Hand → переключается в zoom-mode (иконка Cursor):
   - Two-finger scroll → zoom
   - Shift + scroll → панорама
4. F5 → mode сохраняется (localStorage)

## Что в каждом файле (для понимания)

**`src/lib/engine/runners.ts`**:
- Добавлен `limit_generations: false` в Nano Banana payload
- В user prompt LLM-вызовов добавлен finalize-блок с напоминанием формата

**`src/lib/engine/systemPrompts.ts`**:
- Переписан BASE_CONTEXT с гораздо более жёсткими "ABSOLUTE OUTPUT RULES"
- Явно запрещены "Вот", "Here is", `**КОНЦЕПТ**`, `---`

**`src/components/canvas/Canvas.tsx`**:
- `scrollMode` state + persist в localStorage
- `onWheel` handler учитывает scrollMode
- `resolvedInputs` computed для каждой ноды (text-typed upstream outputs)
- Toggle button в zoom-toolbar

**`src/components/canvas/CanvasNode.tsx`**:
- Принимает `resolvedInputs` prop, рисует превью над textarea
- Textarea auto-grow до 200px
- Text output rendering — full text + scroll + Copy
- Resize handle в правом нижнем углу (только vertical, NODE_WIDTH фиксированный из-за edge geometry)
- Lightbox state + render
- Expand button overlay на preview media

**`src/components/canvas/NodeExpandedModal.tsx`**:
- Text result — full text + scroll + Copy
- Image/video result — кликабельный → открывает Lightbox

**`src/components/canvas/Lightbox.tsx`** *(новый)*:
- Fullscreen viewer для image/video
- Esc / клик вне / X закрывают
- Download button
- Body scroll lock пока открыт

## Подсказки

После накатки в зум-баре внизу появится дополнительная кнопка справа от Maximize. Если она показывает руку 🖐️ — обычный scroll panит. Если курсор 🖱️ — обычный scroll zoomит. Клик переключает.
