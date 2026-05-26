# 🔧 Step 4.13 — Brand Assets hotfix + brand-kit toggle

**5 файлов.** Type-check 0 ошибок.

## Что чинит

### 🐛 #4 (главное): только 1 картинка передаётся даже когда выбрано несколько

**Корневая причина**: я в executor проверял `upstreamNode.results` — это **снимок** graph-ноды, статический, обновляется только при сохранении графа. Свежие результаты живут в `state.results` Map, в которой и были все 4-5 URL после выполнения brandAssets ноды. resolveInputs к этой Map не имел доступа.

**Фикс**: передаю `state.results` в `resolveInputs`. Когда edge идёт от brandAssets к multi-port → читаю live результаты из state.results и пушу все URL в массив. Fallback на graph snapshot для cached subgraph runs.

`src/lib/engine/executor.ts`

### 🐛 #3: смена выбора не учитывается на следующем запуске

**Корневая причина**: subgraph-run кэширует upstream-ноды. При ▶️ на ImageGen, executor берёт cached `outputs` от brandAssets (где outputs.images = первый URL). Brand Assets runner не вызывается заново. И `state.results` остаётся пустым → resolveInputs опять видит только первый URL.

**Фикс — два слоя**:
1. **Кэширование results тоже**: при subgraph-run восстанавливаю не только `state.outputs`, но и `state.results` из `node.results` снимка.
2. **Инвалидация при смене**: в `updateNodeConfig` для brandAssets-нод когда меняется `selected` — чищу `outputs/results/status`. На следующий ▶️ нода перезапустится с новым выбором.

`src/lib/engine/executor.ts` + `src/components/canvas/Canvas.tsx`

### 🎚️ #2: чекбокс "Use brand kit" на ImageGen и LLM нодах

Default **true** (поведение как сейчас). Откроешь Expanded view ноды → в Settings внизу видишь toggle "Auto-attach brand UI screenshots" / "Use brand kit (voice + screenshots)". 

**Когда OFF**:
- imageGen: brand screenshots не цепляются как refs, voice text не приходит
- LLM: ни screenshots ни voice text не уходят

Так можешь в одном workflow брендовые ноды держать `ON`, а off-brand эксперименты делать с `OFF` — не отключая весь brand kit и не пересоздавая ноды.

**Старые** workflow без этого поля = default true (backwards compatible).

`src/lib/canvas/types.ts` + `src/lib/engine/runners.ts`

### 🪗 #1: Brand Assets — collapse/expand

Раньше всегда показывал полный grid (был громоздкой даже после выбора).

**Теперь**:
- При **первом** открытии (selected пустой) → grid развёрнут, видишь все скриншоты, scroll до 240px max-height (если их 100 — scrollable)
- После выбора → жмёшь **Done** → нода сворачивается, показывает только до 4 thumbnails выбранных + "+N" badge
- Хочешь перевыбрать → жмёшь **Edit** → опять полный grid

При следующем открытии workflow если у тебя уже что-то выбрано — нода **сразу collapsed** (не отвлекает). Если selected пустой — automatically expanded (нужно выбрать).

`src/components/canvas/BrandAssetsPicker.tsx`

## Файлы

```
src/lib/engine/executor.ts                ← results map в resolveInputs + caching
src/lib/engine/runners.ts                 ← useBrandKit gate
src/lib/canvas/types.ts                   ← useBrandKit field + defaults
src/components/canvas/Canvas.tsx          ← invalidate cache on selected change
src/components/canvas/BrandAssetsPicker.tsx  ← collapse/expand + scroll
```

## Как накатить

1. Распакуй `flowlab-step4.13-brand-assets-fixes.zip`
2. GitHub → Upload files → перетащи `src`
3. **5 files updated**
4. Commit: `Step 4.13: brand assets multi-URL fix + cache invalidation + useBrandKit toggle`
5. Vercel build

## Тесты

### 🐛 Тест #1 — Brand Assets передаёт все выбранные
1. Создай Brand Assets → expand → выбери **3 разных** скриншота
2. Жми Done → нода свернулась, видишь strip из 3 thumbnails
3. Подключи Brand Assets `images` → Image Generation `images` (multi-port)
4. В ImageGen instructions: "сделай коллаж из этих UI экранов"
5. Run
6. ✅ В Vercel logs увидишь что в Nano Banana пошли **3 image_url** (не 1)
7. Результат содержит элементы всех 3 экранов

### 🐛 Тест #2 — Смена выбора применяется
1. После теста #1 — жми Edit на Brand Assets ноде
2. Сними галки с 2 из 3, выбери 2 **других**
3. Жми Done
4. ▶️ на Image Generation
5. ✅ Использует **новые 2** скриншота, не старые 3 (раньше кэш делал старые)

### 🎚️ Тест #3 — Toggle useBrandKit
1. В workflow внутри Cleaner Kit → создай Image Generation (НЕ подключай Brand Assets)
2. Maximize2 → Settings → видишь toggle "Auto-attach brand UI screenshots" — ON
3. Instructions: "красная спортивная машина в студии"
4. Run → ✅ Получишь car-картинку, но с попыткой использовать UI скриншоты как refs (получится странно)
5. Открой Settings → flip toggle OFF
6. Run ещё раз
7. ✅ Чистая генерация машины без brand context

### 🪗 Тест #4 — Brand Assets compact view
1. Открой brand с 14+ screenshots
2. Создай Brand Assets → видишь полный grid с scroll (если их много — реально scrollable)
3. Выбери 2 → Done
4. ✅ Нода ужалась — видно 2 thumbnails + кнопка Edit
5. F5 — нода сохранилась в compact виде

## Что я НЕ ломал

- Старые workflows без `useBrandKit` field → default true → ведут себя как раньше (auto-attach как было)
- Brand Voice text injection всё ещё работает (но управляется тем же toggle — flip OFF выключает и voice, и screenshots)
- Если в workflow есть upstream image edges (Upload Image и т.п.) — auto-inject отключается (как было)
- Brand Assets без selection всё ещё forwarding все screenshots (как было)

## Что отложено

- **#7** Multi-shot Kling V3 + Seedance 2 — изучу fal API
- **#4 (твоё, давно)** Click-to-expand intermediate node size — отдельный UX патч
- **#8** Organize/minimap/groups — большой UX

После теста этого — берусь за Multi-shot.
