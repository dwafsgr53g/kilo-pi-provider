# Локальная установка Kilo Pi Provider

Отдельная постоянная копия репозитория с собственными исправлениями. Pi настраивается на неё как на локальный пакет, поэтому обновления Pi и официального провайдера не перезаписывают правки.

## Расположение

- Рабочая копия: `C:\AI\pi-extensions\kilo-pi-provider`
- Ветка с исправлениями: `pi-thinking-map`
- `origin`: `https://github.com/dwafsgr53g/kilo-pi-provider.git` (собственный fork)
- `upstream`: `https://github.com/Kilo-Org/kilo-pi-provider.git` (официальный репозиторий)

## Коммиты с исправлениями

| Хеш | Что |
|---|---|
| `4293b0b18f1bcce959d65e9f8d14915b477d206a` | `Map thinking levels from Kilo metadata` |
| `efd6aa79cbc18a35f29c1ed2f7d0c38a7f96878c` | `chore: ignore local anti-slop audit reports` |

Первый коммит содержит только `src/models.ts` и `test/models.test.ts`. Второй добавляет `anti-slop/` в `.gitignore`, чтобы локальные отчёты аудита не попадали в индекс.

## Зависимости

Локальные пакеты Pi не устанавливают зависимости сами. Они нужны для запуска расширения (`typebox` и остальные dev-зависимости), поэтому после клонирования или обновления выполните:

```bash
npm ci
```

## Тесты и проверки

```bash
npm run typecheck
npm test
npx biome lint --error-on-warnings .
```

`npm run check` в этом репозитории вызывает `biome check --write`. Он переформатирует файлы, потому что в репозитории смешаны CRLF и LF, а Biome ожидает LF. Это состояние было до наших правок и не связано с ними. Для проверки без записи используйте `npx biome lint --error-on-warnings .`: он проходит чисто. Все 72 диагностики `biome check` относятся к форматированию переводов строк.

## Обновление из upstream

Обновление выполняется вручную и только после проверки конфликтов.

1. `git fetch upstream`
2. `git log --oneline HEAD..upstream/master` и `git diff --stat HEAD...upstream/master`, чтобы увидеть объём изменений.
3. `git merge upstream/master`
4. Разрешите конфликты, сохранив свой автомаппинг. Конфликты ожидаются в `src/models.ts` в блоке `buildThinkingLevelMap` и в `test/models.test.ts` в наборе `buildThinkingLevelMap`.
5. `npm run typecheck`, `npm test`, `npx biome lint --error-on-warnings .`
6. `git commit` и `git push origin pi-thinking-map`

Не выполняйте `git reset --hard`, `git clean` и `git merge upstream/master` без просмотра изменений.

### Как разрешать конфликты

- `readKiloReasoning`, `orderByIntensity`, `pairUnnamedEfforts` и `buildThinkingLevelMap` должны остаться в той форме, в которой они описаны в коммите `4293b0b`. Если upstream изменил структуру каталога, сначала адаптируйте чтение полей, затем проверьте тестами соответствие количества уровней.
- `mapOpenRouterModel` должен вызывать `buildThinkingLevelMap` и не должен содержать подстановок для отдельных моделей.
- Если upstream добавил новые поля в `opencode.variants` или `opencode.reasoning_options`, привнесите их в тип `OpenRouterModel`, но не меняйте логику отображения без отдельного согласования.
- Тесты `test/models.test.ts` из коммита `4293b0b` не переписывайте. Если upstream изменил тест-файл, сохраните обе группы тестов.

## Возврат к официальному пакету

1. Откройте `C:\Users\user\.pi\agent\settings.json`.
2. В `packages` замените путь `..\..\..\..\AI\pi-extensions\kilo-pi-provider` на `git:github.com/Kilo-Org/kilo-pi-provider`.
3. Перезапустите Pi или выполните `/reload`.

Локальная копия при этом остаётся на диске и не удаляется.

## Проверка, что Pi использует локальную копию

```bash
pi list
```

В списке должен быть путь `C:\AI\pi-extensions\kilo-pi-provider` и не должно быть записи `git:github.com/Kilo-Org/kilo-pi-provider`.

Затем:

```bash
pi -p "Reply with exactly: OK" --no-tools
```

Ответ без предупреждений о загрузке расширений означает, что провайдер `kilo` зарегистрирован из локального пакета.

## Особенности окружения

- В репозитории задана локальная git-идентичность: `dwafsgr53g <200160321+dwafsgr53g@users.noreply.github.com>`. Глобальный git-конфиг не менялся.
- Каталог моделей Kilo меняется часто. Количество уровней в `/thinking` пересчитывается при каждой загрузке каталога, поэтому список может отличаться от описанного в коммите.
- `anti-slop/` не отслеживается git и содержит локальные отчёты аудита.