# 🎨 Step 4.11 — Brand Kit (product context + UI screenshots + auto-inject)

**7 файлов** (включая Prisma migration + schema).

## Что внутри

### 1. Новые поля BrandKit (4 шт)

| Поле | Зачем |
|---|---|
| `productPitch` | 1-3 предложения "что этот апп делает". Самое важное для LLM |
| `appStoreUrl` | App Store ссылка — LLM знает категорию и название как в магазине |
| `googlePlayUrl` | Google Play ссылка |
| `uiScreenshots` | Newline-separated CDN URLs (загружаются через drag-drop в UI) |

### 2. Auto-inject в каждый LLM-вызов

Создан `src/lib/engine/brandContext.ts` с функцией `buildBrandContext(brandId)`. Она формирует markdown-бриф:

```markdown
**Brand:** Cleaner Kit
**Product pitch:** A privacy-first storage cleaner for iPhones…
**Stores:** App Store: https://…
**Tone of voice:** Friendly, witty, no jargon…
**Words to prefer:** effortless, lightweight, focused
**Words to avoid:** cheap, basic, simple
**Banned themes (NEVER reference):** gambling, dating
**Brand colors:** #10b981, #0f172a
**Fonts:** Inter, Source Serif Pro
```

Этот текст автоматически кладётся в `ctx.brandVoice` каждый раз когда запускается **любой** workflow в брендe. Runner LLM-нод уже умеет добавлять `brandVoice` в prompt (это было с 4.6).

**Результат**: открыл workflow в бренде "Cleaner Kit", запустил Text Generation — модель сразу знает что это очистка памяти, App Store ссылку, тон, что нельзя. Никаких ручных копирований в каждый промпт.

### 3. UI — переписана страница brand-kit

Три блока вместо одной длинной формы:
- **Product context** (новый) — pitch, app store URLs, UI screenshots
- **Voice & lexicon** — голос, voice clones, allow/avoid слова, banned themes
- **Visual identity** — colors, fonts

Внутри Product context — компонент `BrandKitScreenshots`:
- Drag-drop или click-to-pick для загрузки скриншотов
- Multiple files за раз
- Превью thumbnails в grid 9:16
- Удаление по X на hover
- Уже использует existing `/api/upload` endpoint, никаких новых routes

## Файлы

```
prisma/migrations/20260524000000_brand_kit_product_fields/migration.sql  ← новая миграция
prisma/schema.prisma                                                      ← +4 поля в BrandKit
src/lib/engine/brandContext.ts                                            ← новый helper
src/app/api/runs/start/route.ts                                           ← подгружает context
src/lib/actions.ts                                                        ← saveBrandKit с новыми полями
src/app/brands/[slug]/brand-kit/page.tsx                                  ← переписан UI
src/components/BrandKitScreenshots.tsx                                    ← новый клиентский upload-компонент
```

## ⚠️ ВАЖНО: миграция БД

Эта схема меняет таблицу `BrandKit`. Тебе **нужно** запустить миграцию на Supabase прежде чем накатывать код. Иначе Vercel build пройдёт, но приложение упадёт при первом сохранении brand kit.

### Опция A — через Supabase SQL Editor (рекомендую)

1. Supabase dashboard → твой проект → SQL Editor
2. Нажми "New query"
3. Вставь:

```sql
ALTER TABLE "BrandKit"
  ADD COLUMN IF NOT EXISTS "app_store_url"    TEXT,
  ADD COLUMN IF NOT EXISTS "google_play_url"  TEXT,
  ADD COLUMN IF NOT EXISTS "product_pitch"    TEXT,
  ADD COLUMN IF NOT EXISTS "ui_screenshots"   TEXT;
```

4. Run
5. Должно сказать "Success. No rows returned."

### Опция B — оставить файл миграции

Я положил `prisma/migrations/20260524000000_brand_kit_product_fields/migration.sql` в zip. Если у тебя есть локальная среда с `npx prisma migrate deploy` против production DB — она применит автоматически. Если нет — лучше через Opt A.

После миграции — пуш кода. Vercel пересоберёт Prisma client с новыми полями.

## Как накатить

1. **Сначала** выполни SQL миграцию в Supabase (см. выше)
2. Распакуй `flowlab-step4.11-brand-kit.zip`
3. GitHub → Upload files → перетащи `prisma` и `src`
4. GitHub скажет "7 files added/updated"
5. Commit: `Step 4.11: Brand Kit — product context + UI screenshots + auto-inject`
6. Vercel build

## Тесты

### #1 — Brand Kit заполняется
1. Создай бренд (или открой существующий) → перейди в Brand Kit
2. ✅ Видишь три секции: Product context / Voice & lexicon / Visual identity
3. В Product pitch напиши описание (например: "Cleaner Kit — privacy-first iPhone storage cleaner that frees up space without uploading data anywhere")
4. App Store URL: ссылку на свой апп
5. UI screenshots: дропни 2-3 скриншота → должны появиться thumbnails
6. Жми Save
7. F5 → всё сохранилось

### #2 — Auto-inject в LLM работает
1. В этом бренде создай project → workflow → Text Generation node
2. Instructions: "напиши заголовок для нашего апа в стиле рекламного баннера"
3. Run
4. ✅ Output упоминает **именно твой апп** (название, категорию, ценности) — модель знает про него из brand context, ты ничего не копировал в prompt

### #3 — Скриншоты загрузились
1. Brand Kit → UI screenshots → дропни 3 файла
2. ✅ В сетке появились 3 9:16 thumbnails
3. Hover на любой → виден X
4. Кликни X → исчезает
5. Save
6. F5 → 2 оставшихся всё ещё там

## Что отложено (next steps)

| Запрос | Когда |
|---|---|
| **Brand Assets node** — quick-grab screenshots в workflow | Следующий патч (маленький) |
| **#7** Multi-shot для Kling/Seedance | Следующий патч |
| **#4** Компактные ноды с click-to-expand | Следующий патч |
| **#8** Organize/minimap/groups | Большой UX |

После теста этого — берусь за **Brand Assets node** + **multi-shot**. Один патч.

## Что я НЕ ломал

- Все 4.6–4.10.6 фиксы на месте
- Старые brand kit (только voice/colors/fonts) работают без миграции пользователем
- `brandVoice` continues to be optional — если бренд пустой, brandContext возвращает только `**Brand:** Name`, не пугая модель
- Никаких breaking changes для существующих workflows
