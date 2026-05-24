# 🛠️ Step 4.10.6 — Figma-style canvas + Veo debug

**3 файла.**

## Что чинит

### 1. Тачпад работает как в Figma/Miro

Полностью переделал управление канвасом. **Никаких переключателей режимов** — поведение всегда стандартное:

| Что делаешь | Результат |
|---|---|
| Two-finger swipe (trackpad) | **Pan** (любое направление) |
| Mouse wheel | **Pan вертикально** |
| Cmd/Ctrl + scroll | **Zoom** к курсору |
| Trackpad pinch | **Zoom** (браузер сам ставит ctrlKey=true) |
| **Space + drag** | **Pan** (новое — стандарт Figma) |
| Middle-click drag | **Pan** (escape hatch) |
| Alt + drag | **Pan** (escape hatch) |
| Левый клик на ноду | Select / drag node |
| Левый клик на фон | Deselect |

Кнопку Hand/Cursor toggle убрал — она путала и ломала логику. Курсор автоматически становится grab когда удерживаешь Space, grabbing во время drag.

### 2. Veo: лог payload + читаемая ошибка

Раз 6s работает, а 4s падает — значит fal что-то конкретное не любит, и нам нужно увидеть **что именно**. Сделал два улучшения для дебага:

**a)** Перед каждым Veo вызовом теперь в Vercel logs пишется payload:
```
[veo] submitting fal-ai/veo3.1/fast/image-to-video {"prompt":"...","duration":"4s","aspect_ratio":"auto","image_url":"..."}
```

**b)** Когда fal возвращает FAILED, мы теперь извлекаем **читаемую** причину из `logs[].message` или `error` поля, а не показываем сериализованный JSON.

После этого патча: если 4s снова упадёт — пришли мне Vercel logs с строкой `[veo]` и я **точно** скажу что fal недоволен (это может быть image_url не 16:9, или resolution mismatch, или что-то ещё в той конкретной картинке).

Документация fal явно говорит 4s/6s/8s валидны для всех Veo 3.1 эндпоинтов. Так что 4s — это не "не поддерживается", а какая-то комбинация с конкретной картинкой. Без логов угадать не могу.

## Файлы

```
src/components/canvas/Canvas.tsx   ← Figma-style: pan + Space hold, no toggle
src/lib/engine/runners.ts          ← Veo payload logging
src/lib/fal/client.ts              ← Readable FAILED error messages
```

## Тесты

### Тачпад / навигация (главное)
1. **Открой workflow на тачпаде**
2. Two-finger swipe в любую сторону → канвас панится  
3. Cmd + scroll → плавный зум к курсору
4. Pinch (zoom gesture на трекпаде) → зум  
5. Hold **Space** → курсор становится 🖐️
6. Hold Space + drag мышью → канвас панится даже если курсор над нодой
7. Отпусти Space → обычное поведение

На обычной мыши:
1. Wheel → панится вертикально  
2. Cmd/Ctrl + wheel → зум
3. Middle-click drag → pan
4. Alt + left-drag → pan

### Veo дебаг
1. Veo 3.1 Fast (I2V) + 4s + любая картинка → Run
2. Если упадёт — открой Vercel Runtime Logs за момент запуска
3. Найди строку `[veo] submitting ...` — будет видно весь payload
4. Если ниже есть `fal.ai job failed: <message>` — отправь мне эти две строки
5. Я сразу скажу что именно fal не любит

## Что я НЕ ломал

- Все предыдущие фиксы (4.6–4.10.5) на месте
- Старые workflows с сохранённым `flowlab.scrollMode` в localStorage просто игнорируются (нет кнопки → нет toggle)
- Все escape hatches (Alt+drag, middle-click) сохранены

## Что отложено (следующие большие задачи)

| # | Что | Размер |
|---|---|---|
| **5** | Brand Kit с файлами/иконкой/ссылкой + system prompt | 🔴 Большой, миграция БД |
| **7** | Multi-shot для Kling/Seedance | 🟡 Средний, изучу API |
| **4** | Компактные ноды + expand mode | 🟡 Средний |
| **8** | Organize/minimap/groups | 🟡 Средний |

После того как ты протестируешь Figma-канвас и пришлёшь Veo лог — поедем дальше. Скорее всего следующим возьму **Brand Kit** — это самая жирная фича из списка.
