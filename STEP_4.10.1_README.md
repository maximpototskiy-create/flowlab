# 🛠️ Step 4.10.1 — Hotfix

**3 фикса, 7 файлов.**

## Что чинит

### 🔴 #1: В canvas только 1 картинка из 4 (хотя fal сгенерировал все 4)

Главный баг. После 4.9 fal.ai реально стал возвращать 4 картинки (limit_generations: false), но в canvas всё равно отображалась 1, а после refresh пропадало даже это.

**Корневая причина**: в `executor.ts` server-side persist строил `results` массив из `assetEntries`, который собирался из `result.outputs`. Но imageGen runner возвращает в outputs только **первый** URL (`{ image: persisted[0] }` — для downstream нод которые ожидают одно значение). Все 4 URL живут в `result.results`. Сервер их не сохранял в `workflow.graph`.

**Фикс**: server-persist теперь берёт `result.results` напрямую — все 4 URL сохраняются. После refresh видишь все 4 в carousel.

**Файл**: `src/lib/engine/executor.ts` (1 строка изменена)

### 🟡 #2: Resize "тянет только основание", и тексты раздуты по ширине

Ты прислал референс (скрин #1 от другого сервиса) — компактная нода, тексты со scroll внутри, кнопки `↑↓` для разворачивания. То что я сделал в 4.10 (drag resize handle + max-h 280) выглядело "стрёмновато".

**Что изменилось**:
- Убран drag-resize handle (тянул только outer div, контент не растягивался — твоё наблюдение)
- Textarea: max-h `200px → 120px` (компактно)
- Upstream "← context" preview: max-h `150px → 80px` (компактно, со scroll)
- Text output: max-h `280px → 160px` (компактно, scroll внутри)

**Чтобы посмотреть полный текст** → жми `Maximize2` (квадратная иконка с двумя стрелками) в правом верхнем углу шапки ноды → открывается `NodeExpandedModal` с полным текстом, full-screen scroll, copy.

Я НЕ добавил отдельную кнопку "expand до 2x" — потому что `Maximize2` modal уже делает ровно то что нужно (показать всё), и две концепции "expand-inline" + "expand-modal" путали бы.

**Файл**: `src/components/canvas/CanvasNode.tsx`

### 🟡 #3: Белый текст полей в светлой теме

В формах "Create project / brand / workflow / rename" поля имели хардкоженный `text-white` — на белом фоне светлой темы текст сливался.

**Фикс**: `text-white` → `text-fg` во всех формах. В тёмной теме `text-fg` = почти белый (как было), в светлой = почти чёрный (как должно быть).

**Файлы**: 5 файлов: `CreateBrandButton`, `CreateProjectButton`, `CreateWorkflowButton`, `ProjectActions`, `WorkflowRow`. Delete-кнопки на красном фоне оставлены с `text-white` (там это правильно).

## Что в патче (7 файлов)

```
src/lib/engine/executor.ts                ← 🔴 server-persist fix (all results land in graph)
src/components/canvas/CanvasNode.tsx      ← 🟡 compact heights + removed resize handle
src/components/CreateBrandButton.tsx      ← 🟡 text-fg
src/components/CreateProjectButton.tsx    ← 🟡 text-fg
src/components/CreateWorkflowButton.tsx   ← 🟡 text-fg
src/components/ProjectActions.tsx         ← 🟡 text-fg
src/components/WorkflowRow.tsx            ← 🟡 text-fg
```

## Как накатить

1. Распакуй `flowlab-step4.10.1-hotfix.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"7 files will be updated"**
4. Commit: `Step 4.10.1: fix 4-image carousel + compact nodes + light-theme inputs`
5. **Commit changes** → Vercel build

## Тесты

### 🔴 Тест #1 — все 4 картинки в canvas (ГЛАВНЫЙ)
1. Image Generation → Nano Banana 2 → num_results = **4**
2. Run
3. ✅ В ноде сразу видны 4 thumbnails (carousel "1 of 4")
4. **F5** (refresh)
5. ✅ После refresh всё равно 4 thumbnails (раньше после refresh была 1)
6. То же самое с num_results = **2** → должно быть 2 (раньше было 1)

### 🟡 Тест #2 — компактная нода + Maximize2 для full view
1. Сгенерируй текст в Text Generation (длинный — 1000+ символов)
2. ✅ В ноде видишь scrollable preview ~160px высотой, не раздутый
3. Жми **Maximize2** (квадрат со стрелками) в правом верхнем углу шапки ноды
4. ✅ Открывается expanded modal — там полный текст с полным scroll, кнопка Copy

### 🟡 Тест #3 — светлая тема + поля формы
1. Переключись в светлую тему (если ты в тёмной)
2. Создай новый проект (или brand / workflow)
3. ✅ Текст который ты вводишь — **тёмный** (виден), не белый

## Что я НЕ ломал

- Все 4.6/4.7/4.8/4.9 фиксы на месте
- `result.outputs` всё ещё содержит первый URL (нужно для downstream нод которые ждут одно значение `inputs.image`)
- Compact layout сохраняет `whitespace-pre-wrap` и scroll — никакая информация не теряется

## Что отложено

Из твоего списка ещё осталось:
- **#7** organize nodes (auto-layout) + minimap
- **#8** multi-select + group nodes

Сделаю отдельным заходом после твоего тестирования этого hotfix.
