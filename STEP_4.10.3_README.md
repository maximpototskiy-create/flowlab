# 🎯 Step 4.10.3 — РЕАЛЬНАЯ причина "1 картинки вместо 4"

**2 файла**. Я наконец нашёл настоящую причину. Извини что прошлые попытки били мимо — я смотрел на DB ошибки в логах и игнорировал твои слова "в БД всё есть".

## Что на самом деле происходило

Ты был прав — в БД всё есть. Просто я думал про "БД" как `workflow.graph` JSON, а ты, наверное, имел в виду **Supabase Storage** (файлы). Они **разные** места.

Реальная картина что я нашёл в коде:

```
fal.ai генерирует 4 картинки → ✅ 4 URL получены
   ↓
persistAsset копирует ВСЕ 4 в Supabase Storage → ✅ 4 файла на месте
   ↓
runner возвращает {
  outputs: { image: url1 },          ← только ПЕРВЫЙ (для downstream нод)
  results: [url1, url2, url3, url4]  ← все 4 (для carousel)
}
   ↓
executor создает Asset rows ТОЛЬКО для outputs → ❌ 1 Asset row, не 4
   ↓
executor пишет в workflow.graph: results=[все 4] → ✅ 4 URL в graph
   ↓
КЛИЕНТСКИЙ POLLING запускается каждые 4 сек
   ↓
GET /api/runs/[id] возвращает step.assets = [1 ряд] (только 1 Asset)
   ↓
Клиент: assets.length === 1 → НЕ multi → results: undefined
   ↓
КЛИЕНТ ПЕРЕТИРАЕТ graph.results = [4 URL] → undefined ❌
   ↓
В canvas видишь 1 картинку
```

**Связка из двух багов:**
1. Asset table создавался только из `result.outputs` (где 1 URL), а не из `result.results` (где все 4)
2. Клиент при `assets.length <= 1` ставил `results: undefined`, перетирая существующие results

Каждый из них в отдельности не был бы фатальным, но вместе они дали "1 картинка из 4".

## Что в патче

### Fix #1: Asset rows для всех результатов

`src/lib/engine/executor.ts` — теперь Asset rows создаются **из `result.results`** (если есть), а не только из `result.outputs`. Для нод с одним результатом fallback на старое поведение.

После этого `/api/runs/[id]` отдаст `step.assets = [4 rows]`, клиент увидит `assets.length === 4 > 1`, обновит results корректно.

### Fix #2: Defense — не перетирать results на undefined

`src/components/canvas/Canvas.tsx` — даже если по какой-то причине `assets.length <= 1`, не перетираем существующие `n.results`. Если в state уже есть массив (из server-persist в graph при mount, или из предыдущей polling-итерации) — оставляем.

Это защита от регрессии в будущем — если ещё где-то клиент получит "1 asset" из multi-result run, results не потеряются.

## Файлы

```
src/lib/engine/executor.ts          ← Asset rows для каждого результата
src/components/canvas/Canvas.tsx    ← Не клоберит results на undefined
```

## Как накатить

1. Распакуй `flowlab-step4.10.3-asset-rows-fix.zip`
2. GitHub → Upload files → перетащи папку `src`
3. GitHub скажет: **"2 files will be updated"**
4. Commit: `Step 4.10.3: create Asset row per result + don't clobber results in polling`
5. **Commit changes** → Vercel build

## Тесты

### 🔴 Тест #1 — 4 картинки в canvas (РЕАЛЬНО на этот раз)
1. Image Generation → Nano Banana 2 → num_results = **4**
2. Run
3. ✅ В ноде сразу видны 4 thumbnails (carousel "1 of 4")
4. **F5** (refresh)
5. ✅ После refresh — всё ещё 4 thumbnails

### 🟢 Тест #2 — 2 картинки тоже работают
1. num_results = **2** → ✅ 2 thumbnails
2. F5 → ✅ всё ещё 2

### 🟢 Тест #3 — старые workflow не сломались
1. Открой старый workflow с уже сгенерированными вещами
2. ✅ Всё на месте как было

## Если ВСЁ ЕЩЁ только 1 картинка

Тогда нужны Vercel runtime logs за момент генерации. Конкретно строки:
- `[persistAsset]` — сколько раз вызывается (должно быть 4)
- `[executor] graph persist` — если ретраи или ошибки  
- Любые prisma errors

Тогда я смогу проверить landed ли все 4 Asset rows в БД vs что вернула API.

## Что я НЕ ломал

- Все 4.6-4.10.2 фиксы на месте (server-persist retry, connection_limit=10, graceful 503/200, аспект, multi-port, и т.д.)
- Downstream ноды всё ещё получают **один** `outputs.image` URL (`result.outputs` не меняется, только Asset table создание)
- Single-output ноды (videoGen без num_results, etc) работают как раньше через fallback

## Что отложено

- **#7** organize nodes / minimap  
- **#8** multi-select + group nodes

Делаем дальше после теста этого.
