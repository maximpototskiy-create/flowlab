# FlowLab — Final (Step 4 + 4.1 hotfix merged)

Это **полный** проект, готовый к деплою. Включает всё:
- Step 4: реальное выполнение нод через fal.ai, Brand Kit, Run History, темы
- Step 4.1 hotfix: модели 2026 (Claude Opus 4.7, Nano Banana 2, Kling 3.0, Seedance 2, Veo 3.1), правильные входы для видео (start_frame / end_frame / reference), тачпад-пан, рабочие кнопки в шапке нод, drag-плавность

---

## Как залить на GitHub и задеплоить — за 5 минут

### Шаг 1. Подготовь GitHub репозиторий

1. Открой https://github.com/maximpototskiy-create/<имя репозитория>
2. Зайди в **Settings → General** (внизу страницы) → раздел **Danger Zone**
3. Нажми **"Delete this repository"** → подтверди удаление

Спокойно — БД и деплой на Vercel **никак не пострадают**, они отдельные.

4. Вернись на главную GitHub → нажми **"New repository"** (зелёная кнопка)
5. Назови **точно как был** (важно — Vercel смотрит по имени)
6. Видимость — **Private**
7. Не ставь галочки на "Add README", "Add .gitignore" — оставь репозиторий пустым
8. Создай

### Шаг 2. Залей файлы

На пустом репозитории GitHub покажет инструкцию. Игнорируй её. Вместо этого:

1. Нажми **"uploading an existing file"** (синяя ссылка в середине страницы)
2. **Открой Finder**, перейди в распакованную папку этого архива (`flowlab/`)
3. Выдели все файлы и папки внутри **(Cmd+A)** — `src`, `prisma`, `package.json` и т.д.
4. Перетащи их в окно браузера GitHub
5. Подожди пока всё загрузится (полоса прогресса)
6. Внизу страницы: **Commit message** → напиши `Final: Step 4.1 with all fixes`
7. Нажми **"Commit changes"**

### Шаг 3. Vercel автоматически передеплоит

Зайди на https://vercel.com/dashboard → твой проект → вкладка **Deployments**. Через 30 секунд после коммита увидишь "Building..." → через 2-3 минуты "Ready".

### Шаг 4. Проверка на проде

Открой свой URL (https://creative-lab-flow.vercel.app), войди и проверь:
- ☀️/🌙 иконка темы в верхней панели — переключается
- Image Generation нода → дропдаун модели → первая строка **"Nano Banana 2 ⭐"**
- Video Generation нода → 4 input порта слева (prompt, start_frame, end_frame, reference)
- Тачпад двумя пальцами по канвасу — двигает канвас
- Cmd+скролл — зум
- На ноде кнопки ⤢ и ✕ работают
- Правый клик на пустом канвасе → меню нод, работает многократно

---

## Если работает локально

Это опционально. Если хочешь запускать на компе:

```bash
cd ~/Desktop/flowlab
npm install
```

Создай файл `.env.local` (НЕ коммитить!) и скопируй туда содержимое из Vercel Dashboard → Settings → Environment Variables. Только замени `NEXTAUTH_URL` на `http://localhost:3000`.

Запуск:

```bash
npm run dev
```

Открой http://localhost:3000

---

## Что в архиве

- ✅ Полный проект FlowLab Step 4.1
- ✅ `.gitignore` — правильный, не пустит `node_modules` и `.env.local` в репозиторий
- ❌ Без `node_modules/` (восстановится из `npm install` или Vercel сам поставит)
- ❌ Без `.env.local` (свои ключи)
- ❌ Без `.next/` (билд-кеш, не нужен)

Размер архива ~170 KB.

---

## Что есть на проде после деплоя

40+ нод в 7 категориях:
- **Text:** Your Text, Text Generation, Creative Brief, Ad Analysis (vision), Image Ad Prompt, Ad Variation, Video Script, Video Frame Prompt, Video Ad Prompt, Voiceover Script, Music Prompt, Character Prompt
- **Image:** Image Generation, Image Resize, Element Change (Kontext), Image Translation, Product Screen Placement, Character Gen, Upscale, Remove BG, Face Swap, Inpaint, Upload Image
- **Video:** Video Generation (4 входа!), Talking Head, Lipsync, Motion Transfer, Upload Video
- **Audio:** Voiceover (ElevenLabs), Music Gen, SFX Gen, Upload Audio
- **Structural:** Hook, Body, Pack Shot, CTA, Scene, Transition, Logo Reveal
- **Integration:** Custom API, Webhook
- **Tools:** Note, Output, Export AE/Image/Audio

Все они через fal.ai → Supabase Storage → CDN. Run History и Brand Kit работают.

---

## Если что-то пошло не так

1. Vercel билд упал → открой логи деплоя, скинь последние 30 строк
2. Сайт открывается, но при работе с нодами 401/404 от fal.ai → проверь env vars `FAL_API_KEY_1` и `FAL_API_KEY_2` в Vercel
3. Storage upload fails → проверь `SUPABASE_SERVICE_ROLE_KEY` в Vercel
4. Не открывается совсем → проверь `DATABASE_URL` в Vercel и `NEXTAUTH_URL` (должен быть `https://<your-vercel-url>`)



