# Mise en ligne (guide pour le mainteneur)

Le site est une page statique (`index.html` + `data.json` + `core.js`). Il s'héberge gratuitement sur **GitHub Pages**.
Les suggestions sans compte passent par un petit service gratuit, un **Cloudflare Worker** (`worker/worker.js`) : il garde
le jeton GitHub à l'abri et ouvre une pull request pour chaque suggestion. Vous n'acceptez que ce que vous fusionnez.

```
visiteur ──(suggestion + raison)──▶ Worker Cloudflare ──(jeton GitHub)──▶ pull request
                                                                              │ vous relisez puis fusionnez
site GitHub Pages ◀──────────── mise à jour automatique ◀────────────────────┘
```

Dépôt du site : **`HPMP-L/InteractiveMap`** (<https://github.com/HPMP-L/InteractiveMap>). Une fois en ligne, le site sera à
l'adresse <https://hpmp-l.github.io/InteractiveMap/>. Ces valeurs sont déjà dans `index.html` et `worker/wrangler.toml`.

Compter 30 à 40 minutes la première fois. Tout est gratuit.

**Règle d'or : un jeton ou une clé secrète ne se colle jamais dans un chat, un e-mail, un fichier du dépôt ou `index.html`.**
Il se tape seulement dans le champ « Secret » de Cloudflare (ou dans `npx wrangler secret put`). Un jeton qui a été collé
ailleurs doit être supprimé sur GitHub et remplacé par un nouveau.

## Quelle version mettre en ligne

Le dossier local `C:\Users\Hayman\Desktop\InteractiveMap` est la copie du dépôt. Sa racine contient la version retenue
(v2 : carte en bandes exécution / orchestration / caractérisation, mise en page automatique). La v1 (carte dessinée d'après
draw.io) est gardée comme sauvegarde dans `v1-backup/`. Ce dossier est listé dans `.gitignore` : il reste sur cet ordinateur
et n'est jamais envoyé sur GitHub. Pour revenir un jour à la v1, voir la dernière section.

**Python sous Windows** : tapez `py` là où ce guide écrit `py` (sous macOS ou Linux, `python3`). La commande `python` seule
peut ouvrir le Microsoft Store au lieu de lancer Python.

## 1. Mettre le site sur GitHub

1. Le dépôt **public** `HPMP-L/InteractiveMap` existe déjà, et `C:\Users\Hayman\Desktop\InteractiveMap` en est la copie
   locale (déjà reliée à GitHub, sur la branche `main`).
2. Ouvrez un terminal **dans ce dossier** (celui qui contient `index.html` et ce guide), puis :
   ```bash
   git add .
   git status
   ```
   `git status` doit lister les fichiers du site (dont `.github/`, `.gitignore`, `.nojekyll`) et **pas** `v1-backup/`.
   Ensuite :
   ```bash
   git commit -m "Research map"
   git push -u origin main
   ```
   Au moment du `git push`, Git ouvre une fenêtre de connexion GitHub dans le navigateur : connectez-vous là, pas en collant
   un jeton dans le terminal.
   Si `git commit` s'arrête sur « Author identity unknown », git ne vous connaît pas encore sur cet ordinateur. Lancez une
   seule fois les deux lignes suivantes, puis recommencez à partir de `git commit` :
   ```bash
   git config --global user.name "Votre Nom"
   git config --global user.email "VOTRE-ADRESSE"
   ```
   L'adresse apparaît dans l'historique public du dépôt : vous pouvez utiliser celle en `…@users.noreply.github.com`
   indiquée dans GitHub → **Settings → Emails**.
3. Activez GitHub Pages dans les réglages **du dépôt** (pas ceux de votre compte : la page « Pages » de votre profil ne sert
   qu'aux noms de domaine). Lien direct : <https://github.com/HPMP-L/InteractiveMap/settings/pages>. Sinon : page du dépôt →
   onglet **Settings** sous le nom du dépôt (s'il n'apparaît pas, menu **…** à droite des onglets) → barre de gauche,
   section *Code and automation* → **Pages**. Puis, sous **Build and deployment** :
   - **Source** : *Deploy from a branch* ;
   - **Branch** : `main`, dossier `/ (root)`, puis **Save**.

   Au bout d'une à deux minutes, le site est en ligne sur <https://hpmp-l.github.io/InteractiveMap/> (l'adresse s'affiche
   aussi en haut de cette page de réglages).

À ce stade le site fonctionne en lecture. Le bouton « Send » reste désactivé tant que l'étape 5 n'est pas faite ; les
visiteurs peuvent quand même copier leurs suggestions.

## 2. Protéger le dépôt (obligatoire)

Sans cette étape, quiconque obtiendrait le jeton du Worker pourrait publier n'importe quoi sur le site sans passer par vous.
Trois règles, toutes dans **Settings → Rules → Rulesets** du dépôt.

**Règle 1 : `main`** (**New ruleset → New branch ruleset**)
1. **Ruleset name** : `main`. **Enforcement status** : *Active*.
2. **Target branches → Add target → Include default branch**.
3. **Bypass list** : seulement le rôle **Repository admin** (vous), en mode **For pull requests only**. Vous pourrez fusionner
   vos propres pull requests, mais personne, même vous, ne pourra pousser directement sur `main`.
4. Cochez :
   - **Restrict deletions** et **Block force pushes** ;
   - **Require a pull request before merging**, avec **Required approvals : 1**, **Dismiss stale pull request approvals when
     new commits are pushed** et **Require review from Code Owners** ;
   - **Require status checks to pass**, puis **Add checks** : `check` et `suggestion-files`, chacun avec la source
     **GitHub Actions** (pas *Any source*). Ils n'apparaissent dans la liste qu'après leur premier passage : revenez les
     ajouter après la pull request de l'étape 5.
5. **Create**.

**Règle 2 : les autres branches** (**New branch ruleset**)
1. **Ruleset name** : `branches`. **Enforcement status** : *Active*.
2. **Target branches → Add target → Include all branches**, puis **Add target → Exclude by pattern** : `suggestion/**`.
3. **Bypass list** : le rôle **Repository admin**, en mode **Always allow**.
4. Cochez **Restrict creations**, **Restrict updates**, **Restrict deletions** et **Block force pushes**. **Create**.

Ainsi le robot ne peut écrire que dans des branches `suggestion/…`, jamais dans les vôtres. Ne nommez jamais vous-même une
branche `suggestion/…`.

**Règle 3 : les tags** (**New ruleset → New tag ruleset**)
1. **Ruleset name** : `tags`, *Active*, **Target tags → Include all tags**.
2. **Bypass list** : **Repository admin**, **Always allow**.
3. Cochez **Restrict creations**, **Restrict updates** et **Restrict deletions**. **Create**.

Cela empêche le robot de publier des « releases » au nom du dépôt. Enfin, **Settings → General → Features** : décochez
**Wikis**.

Le fichier `.github/CODEOWNERS` désigne `@HPMP-L` comme seul relecteur : seule votre approbation compte. Le compte robot de
l'étape 3 ouvre les pull requests, mais ne peut ni les approuver, ni contourner ces règles, ni modifier vos branches.

Pour modifier vous-même le site ensuite : travaillez sur une branche, ouvrez une pull request, puis fusionnez-la. GitHub
indique alors que la relecture manque (vous ne pouvez pas approuver votre propre pull request) : cochez **Merge without
waiting for requirements to be met (bypass rules)**, puis **Merge**. Faites-le **seulement sur vos propres pull requests**,
après avoir vérifié dans l'onglet **Commits** qu'il n'y a que les vôtres. Un `git push` direct sur `main` est refusé.

## 3. Créer le jeton GitHub du Worker, sur un compte robot

Le Worker ne doit pas utiliser un jeton de votre compte : il agirait en votre nom, avec vos droits d'administrateur.

1. Créez un second compte GitHub gratuit pour le robot (déconnectez-vous ou utilisez une fenêtre privée), par exemple
   `hpmp-l-bot`, avec une autre adresse e-mail. Activez la double authentification sur ce compte et sur le vôtre.
2. Depuis votre compte : dépôt → **Settings → Collaborators → Add people** → `hpmp-l-bot` (un dépôt personnel n'a qu'un
   seul niveau de collaborateur : il n'y a pas de rôle à choisir). Acceptez l'invitation depuis le compte robot.
3. Depuis le compte robot : photo de profil → **Settings → Developer settings → Personal access tokens → Tokens (classic) →
   Generate new token (classic)**. Les jetons « fine-grained » ne peuvent pas viser le dépôt d'un autre compte, d'où ce
   choix.
   - **Note** : `InteractiveMap worker`.
   - **Expiration** : 90 jours (notez la date).
   - **Scopes** : seulement **`public_repo`**. Le Worker refuse un jeton qui a d'autres droits, ou un jeton de votre
     compte.

   Ce que ce jeton permet, s'il fuyait : agir au nom du robot sur n'importe quel dépôt public (ouvrir des tickets, des pull
   requests, des commentaires), et dans ce dépôt créer des branches `suggestion/…` et des pull requests. Grâce à l'étape 2,
   il ne peut ni publier sur le site, ni toucher à vos branches, ni créer de tags. Supprimez-le dès qu'un doute existe.
4. Copiez le jeton (`ghp_…`) et passez **directement** à l'étape 4 pour le coller dans Cloudflare. Ne l'enregistrez nulle part.

Si un jeton fuit (collé dans un chat, un e-mail, une capture d'écran…) : sur GitHub, **Settings → Developer settings →
Personal access tokens**, supprimez-le (**Delete**), créez-en un nouveau et remplacez le secret `GITHUB_TOKEN` du Worker.

## 4. Déployer le Worker Cloudflare et l'anti-spam

1. Créez un compte gratuit sur <https://dash.cloudflare.com> et activez la double authentification.
2. **Turnstile → Add widget** : nom `InteractiveMap`, domaine **`hpmp-l.github.io`**, mode *Managed*. Gardez la page ouverte :
   elle affiche une **site key** (publique) et une **secret key** (secrète).
3. **Workers & Pages → Create** : sur l'écran « Make something new », choisissez **Start with Hello World!**, nommez le
   Worker `research-map-suggestions`, puis **Deploy**. Ne choisissez pas *Connect GitHub* (cela donnerait à Cloudflare un
   accès à vos dépôts, inutile ici) ni *Upload your static files* (le site reste sur GitHub Pages).
4. **Edit code** : remplacez tout le code par le contenu de `worker/worker.js`, puis **Deploy**.
5. **Settings → Variables and Secrets** du Worker, ajoutez :

   | Nom | Type | Valeur |
   |---|---|---|
   | `GITHUB_TOKEN` | **Secret** | le jeton du robot (étape 3) |
   | `TURNSTILE_SECRET` | **Secret** | la *secret key* Turnstile |
   | `GITHUB_REPO` | Text | `HPMP-L/InteractiveMap` |
   | `ALLOWED_ORIGINS` | Text | `https://hpmp-l.github.io` (sans `/InteractiveMap`) |
   | `GITHUB_BRANCH` | Text | `main` (facultatif, valeur par défaut) |

   Sans `TURNSTILE_SECRET` ni `ALLOWED_ORIGINS`, le Worker refuse toutes les suggestions : c'est voulu. Ne créez jamais la
   variable `DEV_ALLOW_UNSAFE` sur ce Worker : elle ne sert qu'aux tests locaux.
6. Notez l'adresse du Worker, du type `https://research-map-suggestions.VOTRE-SOUS-DOMAINE.workers.dev`.
   En l'ouvrant dans le navigateur vous devez voir `"ok":true`, `"repo":"HPMP-L/InteractiveMap"`, `"token":true`,
   `"antiSpamCheck":true`, `"allowedSites":["https://hpmp-l.github.io"]` et `"unsafeTestMode":false`.

Variante en ligne de commande (Node.js requis) : dans `worker/`, `npx wrangler deploy`, puis
`npx wrangler secret put GITHUB_TOKEN` et `npx wrangler secret put TURNSTILE_SECRET` (le terminal demande la valeur ; elle
n'apparaît pas à l'écran). Attention : chaque `npx wrangler deploy` remplace les variables saisies dans le tableau de bord par
celles de `wrangler.toml` (les secrets sont conservés).

## 5. Brancher le site sur le Worker

Dans `index.html`, en haut du fichier, complétez les deux valeurs vides (les autres sont déjà remplies) :

```js
window.SITE_CONFIG = {
  dataUrl: 'data.json',
  suggestEndpoint: 'https://research-map-suggestions.VOTRE-SOUS-DOMAINE.workers.dev/suggest',
  repo: 'HPMP-L/InteractiveMap',
  turnstileSiteKey: 'LA-SITE-KEY-TURNSTILE',   // publique : elle peut figurer dans la page
  contact: ''             // facultatif : votre e-mail, affiché si l'envoi est coupé
};
```

Comme `main` est protégée, faites ce changement sur une branche et passez par une pull request :

```bash
git checkout -b connect-worker
git commit -am "Connect the suggestion worker"
git push -u origin connect-worker
```

Ouvrez la pull request proposée par GitHub et attendez les vérifications vertes. C'est votre propre pull request : cochez
**Merge without waiting for requirements to be met (bypass rules)**, puis **Merge**. Ouvrez ensuite le site, faites une
petite modification de test et envoyez-la : une pull request `Suggestion: …` apparaît, ouverte par le compte robot.
Vérifiez que **Check data** et **Suggestion files** passent, ajoutez-les comme vérifications obligatoires (étape 2, règle 1,
point 4) si ce n'est pas déjà fait, puis fermez cette pull request de test sans la fusionner.

## 6. Au quotidien

- Chaque suggestion arrive comme une pull request intitulée `Suggestion: …`, ouverte par le compte robot, avec la raison
  donnée par le visiteur et l'avant/après de chaque changement. L'onglet **Files changed** montre exactement les lignes
  modifiées de `data.json` ; c'est lui qui fait foi, la description n'est qu'un résumé. Quand les données changent, la même
  pull request met aussi à jour `README.md`, la liste « awesome » générée à partir de `data.json`.
- Deux vérifications tournent sur chaque pull request :
  - **Check data** : `data.json` est bien formé, et `README.md` correspond exactement à `data.json` (personne ne peut y glisser
    autre chose). Si elle est rouge, ne fusionnez pas.
  - **Suggestion files** : une pull request que vous n'avez pas ouverte vous-même (suggestion du robot, fork, autre
    collaborateur) ne modifie que `data.json`, `README.md` et `suggestions/*.md`. Elle tourne depuis la copie de `main` : une pull request
    ne peut ni la modifier ni la désactiver. Si elle est rouge, **ne fusionnez pas**.
- Une pull request qui ne vient pas du compte robot (par exemple d'un fork) n'est pas passée par le Worker : relisez-la
  entièrement. Son titre peut imiter celui d'une suggestion. Pour un fork, **Check data** exécute le code du fork lui-même et
  ne prouve donc rien ; seule **Suggestion files** compte.
- Pour accepter une suggestion : **Files changed → Review changes → Approve**, puis **Merge** (le site se met à jour en une
  à deux minutes). **Ne cochez jamais la case « bypass rules » sur une suggestion** : elle est réservée à vos propres pull
  requests. **Close** refuse la suggestion ; vous pouvez laisser un commentaire.
- Quand une suggestion change des liens, la description commence par « ⚠️ Links changed » : chaque adresse visée y est
  écrite en entier, avant le texte du lien, avec le nom des sites.
- Deux suggestions qui touchent la même ligne peuvent entrer en conflit : GitHub propose alors **Resolve conflicts** dans le navigateur.
- Une suggestion qui ajoute une boîte à la carte ne contient pas de coordonnées : elle dit seulement sous quelle boîte la
  placer, et la page la met en place elle-même, sans chevauchement.
- Vous pouvez aussi modifier `data.json` vous-même (voir « Modifier la carte à la main » plus bas). Remettez-le ensuite au
  format attendu avec `node tools/check-data.js --fix`, ou sans Node avec `py tools/format_data.py` (même résultat), puis
  régénérez `README.md` (voir « La liste awesome » plus bas).
- Si vous modifiez `core.js`, lancez `py tools/sync_core.py` à la racine du dépôt, puis recollez `worker/worker.js` dans Cloudflare.
- Tous les 90 jours : générez un nouveau jeton sur le compte robot et remplacez le secret `GITHUB_TOKEN` du Worker.

## La liste awesome (README)

Le `README.md` du dépôt est la liste « Awesome Agentic Capacity Planning ». Il est **généré** à partir de `data.json`
(fonction `CORE.readme` de `core.js`) : ne le modifiez jamais à la main, **Check data** le refuserait.

- Les suggestions envoyées par le site le mettent à jour d'elles-mêmes, dans la même pull request.
- Après une modification de `data.json` à la main : lancez `py -m http.server` à la racine du dépôt, ouvrez
  <http://localhost:8000/tools/readme.html>, cliquez sur **Copy** et collez le texte dans `README.md` (en remplaçant tout).
  Avec Node : `node tools/check-data.js --fix` le réécrit directement.
- Le nom de la liste et son sous-titre viennent de `data.json` (`meta.title`, `meta.subtitle`). L'adresse du site et le dépôt
  sont dans `core.js` (`SITE` et `REPO`, en haut de la partie README) : une suggestion ne peut donc pas les changer. Le nom
  affiché en haut du site et dans l'onglet du navigateur est écrit dans `index.html` (balise `<title>` et bloc `brand`).
- Pour changer la présentation de la liste, dans une même pull request : modifiez `CORE.readme` dans `core.js`, lancez
  `py tools/sync_core.py`, régénérez `README.md`. Fusionnez-la, puis **recollez tout de suite** `worker/worker.js` dans
  Cloudflare : tant que le Worker garde l'ancienne version, les suggestions arrivent avec un README que **Check data** refuse.
- Deux suggestions en attente peuvent toucher des lignes voisines du README. Après la fusion de la première, GitHub signale
  alors un conflit sur la seconde : **Resolve conflicts**, gardez les deux lignes (sans les marques `<<<<<<<`, `=======`,
  `>>>>>>>`), puis **Mark as resolved** et **Commit merge**. **Check data** revérifie le résultat.
- Si **Check data** devient rouge sur `main` avec « README.md does not match data.json » (par exemple après deux fusions
  coup sur coup) : régénérez `README.md` comme ci-dessus, sur une branche, et fusionnez-la. La suggestion suivante l'aurait
  de toute façon remis à jour.

**Mise en service (une seule fois)**, dans cet ordre :
1. Fusionnez ou fermez les suggestions encore ouvertes.
2. Fusionnez la pull request qui apporte la liste awesome.
3. Recollez **aussitôt** le nouveau `worker/worker.js` dans Cloudflare (**Edit code**, puis **Deploy**).
4. Envoyez une suggestion de test depuis le site : la pull request doit contenir `data.json` **et** `README.md`, avec
   **Check data** et **Suggestion files** verts. Fermez-la ensuite sans la fusionner.

Pour les auteurs, chaque fiche de papier sur le site propose un badge « Mentioned in Awesome » à afficher sur leur page de
projet, avec un lien vers leur fiche : c'est l'incitation à venir compléter la carte.

## Anti-spam : ce qui protège vraiment

Rien n'est publié sans votre approbation : au pire, du spam crée des pull requests que vous fermez.

Le Worker :
- exige la vérification Cloudflare Turnstile, résolue sur votre site (`hpmp-l.github.io`) pour l'envoi d'une suggestion ;
- n'accepte que votre site (`ALLOWED_ORIGINS`) ;
- limite à 6 suggestions par heure et par connexion (toutes les adresses IPv6 d'un même abonné, un bloc /56, comptent pour une) ;
- plafonne la taille et le nombre de changements ;
- refuse les suggestions quand 40 attendent déjà votre relecture (`MAX_OPEN`) ;
- filtre aussi les robots naïfs (champ piège invisible, délai minimal avant envoi).

La limite par heure est tenue en mémoire par chaque instance du Worker : elle freine mais ne bloque pas un script réparti.
C'est Turnstile qui arrête les robots.

**Recommandé : une limite de débit tenue par Cloudflare lui-même.** Elle ne se règle pas dans le tableau de bord et demande
un déploiement en ligne de commande (Node.js requis) ; modifier `worker/wrangler.toml` sans redéployer n'a aucun effet.
1. Vérifiez que les valeurs de `[vars]` dans `worker/wrangler.toml` sont celles de l'étape 4 : au déploiement, elles
   remplacent les variables du tableau de bord (les secrets `GITHUB_TOKEN` et `TURNSTILE_SECRET` sont conservés).
2. Décommentez le bloc `[[ratelimits]]`.
3. Lancez `npx wrangler deploy` dans `worker/`. Le Worker `research-map-suggestions` existant est mis à jour.
4. Rouvrez l'adresse du Worker : elle doit toujours répondre `{"ok":true,…}`, avec votre dépôt dans `"repo"`.

## Sans le Worker

Si vous ne voulez pas (encore) du Worker, laissez `suggestEndpoint` vide et mettez votre adresse dans `contact` (`index.html`) :
les visiteurs pourront copier leurs suggestions et vous les envoyer par e-mail.

## Modifier la carte à la main

La carte n'a pas de coordonnées : la page la dessine à partir de sa structure, rangée dans `data.json` sous `map`.

- `map.lanes` : les trois bandes, de haut en bas (`execution`, `orchestration`, puis `characterization`, qui porte
  `"span": true` parce qu'elle occupe toute la largeur). Chaque bande a un `label`, une phrase `desc`, et peut avoir des
  `links` vers les matrices, comme une boîte.
- `map.columns` : les colonnes `W`, `T`, `R`, `C`, chacune reliée à sa boîte d'en-tête (Workload, Trajectory…).
- `map.nodes` : les boîtes. Chacune a :
  - soit un `parent`, l'identifiant de la boîte sous laquelle elle se range ;
  - soit, pour la première boîte d'une branche, une `lane` et une `column` (sans `column` dans la bande `characterization`).

  `also` liste des boîtes liées, dessinées en pointillés quand l'une des deux est sélectionnée.

Exemples (champs simplifiés) :

```json
{ "id": "k3PXRv-HAhmkEIkEhYpQ-20", "kind": "concept", "text": "State", "lane": "orchestration", "column": "R" }
{ "id": "k3PXRv-HAhmkEIkEhYpQ-156", "kind": "concept", "text": "Phase definition", "parent": "k3PXRv-HAhmkEIkEhYpQ-20" }
```

- **Déplacer une branche** : changez le `parent` de sa première boîte. Toute la branche suit. Pour en faire une nouvelle
  branche, enlevez `parent` et mettez `lane` et `column`.
- **Montrer un papier dans les deux bandes** : ajoutez une deuxième boîte `"kind": "paper"` avec le même `paper`, un
  nouvel `id` et sa propre phrase `text`. Les deux boîtes affichent « also in … ».
- **Ordre** : sous une même boîte, les notes « Key insights » passent en premier, puis les autres dans l'ordre du fichier.
- **Règles** :
  - au plus 5 niveaux sous la première boîte d'une branche ;
  - rien sous une note, sous la bibliographie ou directement sous un en-tête de colonne ;
  - la bibliographie et « Problem framing » n'ont ni bande ni colonne : elles restent au-dessus de la grille.

Après une modification, remettez le format avec `py tools/format_data.py` (ou `node tools/check-data.js --fix`), régénérez
`README.md` (voir « La liste awesome »), puis vérifiez : `node tools/check-data.js` vérifie toutes ces règles et indique la
boîte en cause. Sans Node, ouvrez `tools/check-data-test.html` (voir ci-dessous) : sa première ligne doit dire `clean data: exit 0`.

## Tester sans GitHub

Lancez `py -m http.server` à la racine du dépôt, puis ouvrez :

- <http://localhost:8000/tools/worker-test.html> : fait tourner `worker/worker.js` contre un GitHub simulé
  (110 vérifications, dont les tentatives d'abus, l'anti-spam, le contrôle du jeton et la liste awesome). La première ligne
  doit indiquer `0 failed`.
- <http://localhost:8000/tools/check-data-test.html> : lance la vérification de `data.json` dans le navigateur, puis sur une
  copie volontairement cassée, et sur un `README.md` modifié à la main, pour montrer qu'elle détecte bien les erreurs.
- <http://localhost:8000/tools/readme.html> : affiche le `README.md` généré à partir de `data.json`, à copier.

## Coûts et limites

- GitHub Pages : gratuit pour un dépôt public.
- Cloudflare Workers : gratuit jusqu'à 100 000 requêtes par jour.
- Le jeton GitHub expire : pensez à le renouveler à la date choisie.

## Revenir à la v1

1. Fermez les pull requests de suggestion encore ouvertes : elles ont été préparées pour la v2.
2. Dans `C:\Users\Hayman\Desktop\InteractiveMap`, sur une nouvelle branche, remplacez les fichiers du site par ceux du
   dossier `v1-backup`, dossiers cachés compris, mais gardez `.gitignore`, `.github/CODEOWNERS` et
   `.github/workflows/suggestion-files.yml` (la v1 ne les a pas), et ne supprimez pas `v1-backup/` lui-même.
3. Le nouvel `index.html` a un `SITE_CONFIG` vide : refaites l'étape 5, sinon le bouton « Send » reste désactivé.
4. Committez, passez par une pull request (`main` est protégée), puis recollez le `worker/worker.js` de la v1 dans
   Cloudflare (étape 4). Attention : la v1 n'exige pas Turnstile ; refaites l'audit de sécurité avant de la remettre en ligne. Les deux versions valident
   les suggestions différemment, donc le site et le Worker doivent venir du même dossier. Les variables du Worker et le
   jeton ne changent pas.

Attention : le `data.json` de la v1 est la version d'origine et range la carte autrement (coordonnées au lieu de bandes et
de colonnes). Les suggestions fusionnées depuis la mise en ligne de la v2 n'y sont pas : reportez-les à la main à partir de
l'historique du dépôt. Les papiers, tableaux et matrices ont le même format dans les deux versions, la carte non.
