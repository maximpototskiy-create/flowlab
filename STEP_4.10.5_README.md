# 🛠️ Step 4.10.5 — Veo + Hand-pan fixes

**3 файла.** Все 4 проблемы из твоего сообщения.

## Что чинит

### 1. Не было Veo 3.1 Fast (I2V) в списке моделей
**Раньше**: только Veo 3.1 (T2V) / Veo 3.1 Fast (T2V) / Veo 3.1 First-Last Frame. Image-to-video Fast версия — самая дешёвая и нужная — отсутствовала.

**Теперь** добавил все 6 правильных вариантов:
- ⭐ **Veo 3.1 Fast (T2V)** — text-to-video Fast (cheapest T2V)
- Veo 3.1 Standard (T2V) — text-to-video Standard (premium)
- ⭐ **Veo 3.1 Fast (I2V)** — image-to-video Fast (cheapest i2v) ← это то что ты искал
- Veo 3.1 Standard (I2V) — image-to-video Standard
- Veo 3.1 Fast (First-Last Frame) — first-last Fast
- Veo 3.1 Standard (First-Last Frame) — first-last Standard

### 2. Duration: выбираешь "5s" — всегда генерится 8s
**Раньше**: duration options были 5/10/15. Runner на Veo делал `coerce → 8` для всего что не 4/6/8. Поэтому 5 всегда становилось 8.

**Теперь**: добавил **4s / 6s / 8s** в выпадающий список (с пометкой Veo) плюс **5s / 10s** (Kling/Seedance) и **15s** (Pixverse). Когда выбираешь 6s — Veo генерит 6s.

Runner для не-Veo моделей либо принимает значение как есть (Kling/Seedance), либо делает coerce per-model к ближайшему. Никаких сюрпризов 5→8.

### 3. First-Last Frame с одним кадром падал 422
**Раньше**: Выбираешь "Veo 3.1 First-Last Frame", даёшь только start_frame → endpoint требует оба → 422.

**Теперь**: runner проверяет, если выбран first-last но end_frame не подключён — **авто-переключается** на обычный i2v endpoint того же tier'а (Fast → Fast, Standard → Standard). Генерирует i2v вместо ошибки.

Логика routing'а Veo полная:
| Выбрана модель | start | end | actualModel |
|---|---|---|---|
| `veo3.1/fast/image-to-video` | ✅ | — | `veo3.1/fast/image-to-video` (без изменений) |
| `veo3.1/fast/image-to-video` | ✅ | ✅ | **upgrade** → `veo3.1/fast/first-last-frame-to-video` |
| `veo3.1/fast/first-last-frame-to-video` | ✅ | ✅ | без изменений |
| `veo3.1/fast/first-last-frame-to-video` | ✅ | — | **fallback** → `veo3.1/fast/image-to-video` |

### 4. Hand-режим (scroll mode pan) не работал
**Раньше**: переключатель Hand 🖐️ в zoom-toolbar менял **только** поведение колеса (scroll = pan). Но левый клик на канвас панил **только** с alt-модификатором или middle-click. Получается "рука" видна как кнопка, но руки-курсора не было, и левая кнопка не панила.

**Теперь** в Hand-mode:
- Курсор на канвасе показывается как **grab** (рука) когда наведён на фон
- **Левый клик + drag** по фону = pan (как в Figma)
- Курсор меняется на **grabbing** во время drag

В Cursor-mode (стрелка):
- Курсор default
- Левый клик = select (как было)
- Alt+drag или middle-click всё ещё панит (escape hatch для обоих режимов)

`src/components/canvas/Canvas.tsx` — изменилась логика `onCanvasPointerDown` + cursor style.

## Файлы

```
src/lib/canvas/types.ts                  ← Veo Fast i2v, duration options
src/lib/engine/runners.ts                ← Veo routing + correct coerce
src/components/canvas/Canvas.tsx         ← Hand-pan left-click + grab cursor
```

## Как накатить

1. Распакуй `flowlab-step4.10.5-veo-hand-pan-fixes.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"3 files will be updated"**
4. Commit: `Step 4.10.5: Veo Fast i2v + duration + hand-pan`
5. **Commit changes** → Vercel build

## Тесты

### #1 — Veo Fast i2v
1. Video Generation → выбери модель → ищи "**Veo 3.1 Fast (I2V) ⭐**" (новая)
2. Подключи одну картинку как start_frame
3. Duration: **6s**
4. Run
5. ✅ Генерируется 6-секундное видео из картинки (не 8с, не 422)

### #2 — Duration реально применяется
1. Veo 3.1 Fast (T2V) → выбери 4s → Run
2. ✅ 4-секундное видео
3. Выбери 6s → Run → 6-секундное
4. Выбери 8s → Run → 8-секундное

### #3 — First-Last с одной картинкой
1. Video Generation → "Veo 3.1 Fast (First-Last Frame)"
2. Подключи **только** start_frame (end не подключай)
3. Run
4. ✅ Генерирует i2v вместо 422 (runner авто-переключился)
5. В Vercel logs увидишь, что фактически вызвал `veo3.1/fast/image-to-video`

### #4 — Hand-pan работает
1. Зум-toolbar внизу → переключатель Hand 🖐️ (должен быть активный по умолчанию)
2. Наведи курсор на пустой канвас → видишь **руку** ✋
3. Зажми левую кнопку → курсор меняется на **grabbing** ✊
4. Двигай — канвас панится
5. Отпусти → курсор обратно в **grab**

Также если ты используешь Cursor mode:
- Alt+drag или middle-click всё ещё работают как pan (старое поведение сохранено как escape hatch)

## Что НЕ сломал

- Все предыдущие фиксы (4.10.4, 4.10.3, 4.7, 4.8, 4.9) на месте
- Kling/Seedance/Hailuo/Pixverse не трогал — для них duration работает как раньше
- Existing workflows не сломаются: старые сохранённые duration="5" будут coerce-нуты в 4s или 8s для Veo (4 — ближайший к 5; алгоритм picks closest = 4)

⚠️ Минорный момент: если у тебя есть **старая** сохранённая Veo нода с duration="5", после этого патча она coerce-нётся к **4s** или **8s** (ближайший из 4/6/8). Можешь явно выбрать 6s или 8s.

## Что отложено

- **#4** Compact node + click-to-expand + upstream prompt in expanded view  
- **#5** Brand Kit с файлами/иконкой/ссылкой
- **#7** Multi-shot для Kling V3 / Seedance 2  
- **#8** Organize / minimap / group nodes

После теста этого — двигаемся к Brand Kit (#5), как ты подтвердил план в прошлом сообщении.
