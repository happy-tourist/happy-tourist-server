# Project map

Карта внешних корней для AI-агентов и docs. Не путать с каноном экосистемы
`happy-tourist-meta/docs/projects-map.md` (сервис → путь внутри meta).

| Key | Relative path (from this repo root) | Notes |
|-----|-------------------------------------|--------|
| happy-tourist-meta | .. | Sibling layout: `happy-tourist-server` рядом с `happy-tourist-meta` |
| happy-tourist-client | ../happy-tourist.github.io | Vue/Quasar SPA (GitHub Pages) |

## Resolution

1. Взять путь по ключу `happy-tourist-meta` относительно **корня этого репозитория** (каталог, где лежит этот файл).
2. Считать корень валидным, если существует `{happy-tourist-meta}/docs/projects-map.md`.
3. Если путь не существует / файл не найден — **спросить у пользователя** абсолютный путь к `happy-tourist-meta` и использовать его до конца сессии (не угадывать sibling `../happy-tourist-meta` молча).

## Docs links

В markdown этого репозитория ссылки на канон писать как:

- `happy-tourist-meta/docs/projects-map.md`
- `happy-tourist-meta/docs/...`

Агент резолвит префикс `happy-tourist-meta/` через ключ выше. Не использовать `../../docs/...`.
