# Походження прикладу

Джерело: `07_GRANDAR_Каталог_технічних_задач.docx`, версія 1.0, статус DRAFT, 170 задач. Походить із GRANDAR delivery package від 08.09.2026 у Koitechs PDD generator. До input скопійовано незмінений файл. SHA-256 фіксується в кожному output.

Контракт полів підтверджено AGENTS.md чинного PDD-generator та Decisions log від 08.09.2026 у внутрішній пам’яті Discovery Engine. Каталог має окремі Context / Why, Scope, Implementation Notes, Acceptance Criteria, Edge Cases, Out of Scope, Dependencies, References, оцінки й board labels.

Реалізація спирається на фактичний документ і контракт генератора. Для роботи цього репозиторію доступ до попередніх чатів не потрібен.

Допоміжний проєкт прив’язаний до етапу 9 → delivery; задачі та години походять з етапів 6/8. Це приклад операційного хелпера, не затверджена зміна процесу. Vault не змінювався.

Усі 170 задач містять Requires Tech Lead validation. Структурна перевірка не підтверджує архітектуру, scope чи клієнтські рішення. Повне semantic review не виконано під час створення прикладу. Перший помітний кандидат на refinement: у задачі T-M1-001 про CI pipeline є UI-орієнтовані loading/empty/error edge cases; вони збережені як у джерелі, без прихованого переписування.
