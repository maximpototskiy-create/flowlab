# 🛠️ Step 4.10.4 — Bugs A + UX B (combined)

**5 файлов.** Type-check ОК.

## A — Прямые баги

### 1. Двоение картинки в Upload Image ноде

**Причина**: для Upload ноды UI рендерил `<UploadZone>` (с крестиком удаления) + дополнительно `<OutputPreview>` (с expand-кнопкой), потому что у Upload ноды есть `node.outputs.image = cdnUrl`. Получалось две копии одной картинки в одной ноде.

**Фикс**: `OutputPreview` теперь **пропускается** для нод с `def.custom` начинающимся на `upload-`. UploadZone — единственная превью. К ней добавлена кнопка Expand (показывает в Lightbox) — теперь паритет с генерированными.

`src/components/canvas/CanvasNode.tsx` + `src/components/canvas/UploadZone.tsx`

### 2. Veo 422

Проверил свежую fal.ai доку — нашёл **4 несовпадения** в payload:

| Что | Было | Стало |
|---|---|---|
| `duration` | число `5` | строка `"4s"` / `"6s"` / `"8s"` (только эти 3 значения) |
| `aspect_ratio` | любое (1:1, 4:5, ...) | только `auto` / `16:9` / `9:16` (coerce в `auto`) |
| first-last-frame | один endpoint + `last_image_url` | **отдельный endpoint** `fal-ai/veo3.1/fast/first-last-frame-to-video` + `first_frame_url` + `last_frame_url` |
| audio | `generate_audio` | `audio` (для Veo 3.1; Veo 3 остался на `generate_audio`) |

Auto-routing: если ты выбрал обычный `veo3.1/fast/image-to-video`, но подключил И start, И end frame — runner сам переключится на endpoint first-last-frame. Объясняется почему фронт-логика не меняется.

`src/lib/engine/runners.ts`

## B — UX вокруг результатов

### 3. Выбор какой картинки передавать downstream

**Раньше**: при num_results=4 в downstream-ноду всегда уходила картинка 1.

**Теперь**: клик на любой thumbnail в carousel сохраняет выбор в `node.config._selectedResultIdx`. Когда запускается downstream-нода, executor `resolveInputs()` смотрит на `_selectedResultIdx` upstream-ноды и подаёт **выбранный** URL вместо `outputs.image[0]`.

Делается всё через config-key — никаких миграций БД, выбор переживает refresh.

`src/lib/engine/executor.ts` + `src/components/canvas/CanvasNode.tsx`

### 4. Lightbox для картинок + ←→ навигация

Раньше в Lightbox можно было открыть одну картинку. Теперь:
- Все генерированные картинки кликабельны (как видео раньше) — Expand-кнопка на hover
- Загруженные через UploadZone тоже открываются в Lightbox (Expand на hover)
- В мульти-результате (4 картинки и т.д.) — **стрелки ←/→** в Lightbox + клавиши `ArrowLeft` / `ArrowRight`
- Цикл по списку, "3 / 4" badge внизу

`src/components/canvas/Lightbox.tsx`

## Тесты

### #1 — Upload Image без двоения
1. Drop image into Upload Image node
2. ✅ Один preview, **без копии** ниже
3. Hover на preview → видна **Expand** кнопка слева от X
4. Click Expand → Lightbox открывается

### #2 — Veo генерация работает
1. Image Generation → Nano Banana → одна картинка как start frame
2. Video Generation → выбери `veo3.1/fast/image-to-video`
3. Connect start frame → Run
4. ✅ Не падает с 422 — генерируется

Дополнительно first-last-frame:
1. Connect ещё одну картинку как end_frame
2. ✅ runner автоматически переключится на first-last-frame endpoint
3. В Vercel logs увидишь `fal-ai/veo3.1/fast/first-last-frame-to-video`

### #3 — Выбор результата для downstream
1. Image Generation → Nano Banana → num=4 → Run → 4 картинки в carousel
2. Кликни **3-ю** картинку в carousel (она помечается selected)
3. Создай ниже ещё одну ImageGen ноду (modify the result), connect output → input
4. Run downstream-ноду
5. ✅ Downstream получает **3-ю** картинку как референс (не первую)
6. F5 → выбор сохраняется

### #4 — Lightbox навигация
1. Multi-result ImageGen с 4 картинками
2. Click Expand на любой
3. ✅ Lightbox показывает её, "1 / 4" badge внизу
4. ← → стрелки (клавиши **или** иконки в углах) переключают между 4
5. Loop в конце списка

## Что НЕ в этом патче (отдельные следующие задачи)

| Что | План |
|---|---|
| **#4 (твоё)** Компактная нода + click-to-expand + upstream prompt в expanded | Следующий патч UX overhaul |
| **#5** Brand Kit с файлами/иконкой/ссылкой + как system prompt | Самый большой — нужна миграция БД, новая UI page |
| **#7** Multi-shot для Kling V3 / Seedance 2 | Изучаю API |
| **#8** Organize / minimap / group nodes | Большой UX |

Сделаю Brand Kit + Multi-shot отдельным заходом после теста этого.

## Brand Kit — изучу схему

Из твоего ответа: *"может не просто url, а именно, чтобы оно как-то отображалось уже в базе и сразу использовалось в работе"*.

В Prisma уже есть таблица Brand. Добавлю поля:
- `iconUrl` — иконка приложения, отображается в TopNav когда работаешь в этом бренде
- `appStoreUrl`, `googlePlayUrl` — ссылки на сторы, runner подтягивает в context
- `uiScreenshotUrls` (массив) — UI скриншоты, доступны как референсы для генерации
- `productPitch` — короткое описание продукта, идёт в system prompt всех runs этого бренда

Под "сразу использовалось в работе" я предлагаю: всё это автоматически впрыскивается в `ctx.brandVoice` при каждом run, плюс UI скриншоты доступны через специальный node-type "Brand Assets" (тянет ассеты бренда в виде Upload-Image-like нод одним кликом).

Подтверди этот план для Brand Kit — следующим патчем сделаю.

## Multi-shot — изучу API

Из твоего ответа: *"не дороже, отдельный функционал, дороже только засчёт длительности"*.

Изучу fal.ai endpoints для Kling shot-based и Seedance multi-shot чтобы дать тебе точный план следующим патчем.
