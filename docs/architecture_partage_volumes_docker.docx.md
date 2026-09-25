**ARCHITECTURE**

Partage interne de volumes Docker

Drag & drop • Agent local • Configuration JSON \+ S3 • Notification Google Chat

23 septembre 2026

*Agence NWB · Confidentiel*

L'application est conçue comme un outil interne permettant à des collaborateurs connus de partager simplement un volume Docker d'une machine à une autre. L'utilisateur voit les volumes présents sur son poste, glisse un volume sur un collègue, puis le système prépare et dépose une archive temporaire dans S3.

Le destinataire reçoit une notification dans un canal Google Chat dédié lorsqu'un transfert est prêt et peut ensuite le télécharger sur sa machine. L'architecture reste volontairement légère : l'agent local manipule Docker, le service central orchestre les transferts et la notification, et S3 stocke temporairement les archives volumineuses. Aucune base de données n'est imposée pour le MVP.

# **1\. Principe fondamental**

| ℹ️ Agent local \+ configuration JSON \+ stockage S3Les responsabilités restent séparées : l’agent local est le seul composant qui accède au Docker Engine de la machine ; un fichier JSON statique fournit la liste des collègues autorisés ; S3 conserve uniquement les archives temporaires des volumes. Aucune base de données n’est requise pour le MVP et le service central ne doit pas servir de relais binaire pour les gros fichiers. |
| :---- |

Le flux principal doit rester le plus direct possible :

| Docker local → agent local → S3 → agent du destinataire → Docker local |
| :---- |

Le service central intervient pour exposer la liste des collègues connus, initier les transferts, fournir les informations nécessaires à l'accès S3 et publier une notification dans un canal Google Chat dédié lorsque l'upload est confirmé. Les données du volume transitent directement entre les postes et S3. Le MVP ne nécessite pas de base de données : la configuration des collègues peut être statique et l'état des transferts peut rester minimal.

# **2\. Définition des concepts**

## **2.1 Utilisateur**

Un utilisateur correspond à un collaborateur connu et autorisé à utiliser l'application. Dans le MVP, la liste des collègues est une configuration statique chargée depuis un fichier JSON ; il n'est pas nécessaire de construire un système d'inscription ni une gestion dynamique des comptes.

• Un identifiant technique stable (userId).

• Un nom d’affichage utilisé dans l’interface de drag & drop.

• Éventuellement les informations minimales nécessaires à la notification ou à l’identification de son agent.

Le fichier JSON peut être livré avec l'application sur le serveur ou stocké dans S3 si l'on souhaite pouvoir le modifier sans redéploiement. Le choix exact reste un détail de déploiement et ne change pas le fonctionnement du MVP.

## **2.2 Machine / agent**

Une machine est un poste de développement sur lequel tourne l'agent Bun/TypeScript. L'agent communique avec Docker ainsi qu'avec le service central. Le MVP n'impose pas de registre persistant des machines.

• Identifiant local ou technique de la machine si nécessaire.

• Association logique avec le collaborateur qui utilise l’agent.

• Nom de machine affichable si utile à l’interface.

• Version de l’agent pour faciliter le diagnostic.

La présence en ligne peut être déduite dynamiquement ou ignorée dans une première version.

| 👉 Règle d’accès Docker Le navigateur ne doit pas accéder directement au socket Docker. L’accès à Docker est concentré dans l’agent local, qui expose uniquement les opérations nécessaires à l’application. |
| :---- |

## **2.3 Volume**

Un volume correspond à un volume Docker présent sur une machine. Il est découvert dynamiquement via l’API Docker locale. La liste des volumes n’est pas persistée : l’état réel est celui du Docker Engine de la machine.

• Nom du volume Docker.

• Driver et labels utiles à l’affichage si disponibles.

• Taille lorsque l’agent peut la déterminer sans coût excessif.

• Machine source.

## **2.4 Transfert**

Un transfert représente l’envoi d’un snapshot d’un volume depuis un utilisateur vers un autre. Il possède un identifiant technique temporaire qui sert à relier l’archive S3, l’expéditeur, le destinataire et l’état courant du transfert pendant son cycle de vie.

# **3\. Stockage des données**

Les archives de volumes sont stockées temporairement dans S3. Le module interne NWB \`s3-node\` est utilisé comme abstraction S3 par l’application afin de conserver les pratiques et la configuration déjà utilisées en interne.

Une clé S3 simple et non ambiguë est suffisante :

| docker-volume-transfers/{transferId}/volume.tar.zst |
| :---- |

Le nom réel du volume reste une métadonnée du transfert et ne sert pas directement de clé de stockage. Cela évite les collisions, les caractères spéciaux et les problèmes liés au renommage.

Le MVP ne requiert pas de base de données dédiée.

• Les collègues autorisés sont décrits dans un fichier JSON statique.

• Les volumes sont découverts à la demande par chaque agent local.

• Les archives de volumes sont stockées temporairement dans S3.

• Les informations d’un transfert peuvent rester temporaires côté service central pendant sa durée de vie.

S3 est la source de vérité du binaire temporaire. Aucun mécanisme de persistance applicative supplémentaire n'est imposé tant qu'un besoin concret ne le justifie.

## **3.1 Configuration minimale des collègues**

Pour le MVP, un simple fichier \`users.json\` suffit pour décrire les destinataires proposés dans l'interface.

Exemple : \`\[{ "id": "mael", "name": "Maël" }, { "id": "thomas", "name": "Thomas" }\]\`.

Ce fichier peut être embarqué avec l'application lors du déploiement ou stocké dans S3. Le stockage avec l'application est l'option la plus simple ; S3 permet de modifier la liste sans redéployer.

Aucune table \`user\`, \`machine\` ou \`transfer\` n'est requise dans le MVP.

Si l'usage réel fait apparaître un besoin d'historique, de reprise, d'audit ou de concurrence plus complexe, un mécanisme de persistance pourra être ajouté ultérieurement.

Le principe à respecter est de ne pas introduire de composant de persistance tant que le besoin n'est pas démontré.

# **4\. Responsabilités de l’agent local**

L’agent local est responsable de :

• Détecter et lister les volumes Docker présents sur la machine.

• Recevoir les commandes de l’interface locale concernant un volume.

• Créer une archive cohérente du contenu du volume sélectionné.

• Compresser l’archive avant envoi.

• Uploader directement l’archive vers S3 avec les informations fournies par le backend.

• Télécharger une archive reçue depuis S3.

• Restaurer l’archive dans un volume Docker local lorsque l’utilisateur le demande.

• Remonter au backend la progression et le résultat des opérations.

| 🚧 Frontière stricte L’agent ne gère ni la liste globale des utilisateurs, ni les droits métier, ni la conservation des transferts. Il manipule Docker et exécute les opérations locales demandées par un utilisateur autorisé. |
| :---- |

# **5\. Responsabilités du backend central**

Le backend est responsable de :

• Charger et exposer la liste statique des collègues autorisés.

• Créer un identifiant temporaire pour chaque transfert.

• Coordonner l’expéditeur et le destinataire pendant la durée du transfert.

• Utiliser le module interne \`s3-node\` pour les opérations S3 nécessaires.

• Fournir à l’agent le mécanisme nécessaire pour uploader ou télécharger l’objet S3.

• Conserver uniquement l’état temporaire nécessaire au bon déroulement du transfert.

• Publier dans le canal Google Chat dédié une notification lorsque l'archive est effectivement disponible dans S3.

• Lire l'URL du webhook Google Chat depuis une variable d'environnement côté serveur, par exemple \`GOOGLE\_CHAT\_WEBHOOK\_URL\`.  
• Inclure dans le message Google Chat : le nom du volume / de l'archive, l'expéditeur, le destinataire et la date/heure jusqu'à laquelle l'archive reste disponible.  
• Laisser S3 gérer l’expiration physique des archives via une règle de cycle de vie.

Le backend ne reçoit pas puis ne réémet pas les archives de volume. Ce choix évite de dimensionner le serveur applicatif en fonction de la taille des transferts.

# **6\. Communication entre les systèmes**

Le système communique selon deux axes :

• Agent ↔ service central : API HTTP pour récupérer les collègues, initier un transfert et signaler ses changements d’état.

• Agent ↔ S3 : upload et download directs des archives.

Pour la notification utilisateur, la V1 utilise un webhook entrant vers un canal Google Chat dédié. Le webhook est configuré uniquement côté serveur via une variable d'environnement. Aucun WebSocket ou Server-Sent Events n'est requis pour ce besoin dans le MVP.

Exemple de flux :

1\. Maël ouvre l’application ; l’agent liste les volumes Docker de sa machine.

2\. Il glisse \`mysql\_client\_x\` sur le collègue Thomas.

3\. Le service central crée un identifiant de transfert et retourne les informations nécessaires à l’upload S3.

4\. L’agent source archive et compresse le volume, puis l’upload directement vers S3.

5\. L'agent source signale au service central que l'upload S3 est terminé et confirmé.

6\. Le service central calcule la date d'expiration du transfert à partir de la durée de rétention configurée.

7\. Le service central publie dans le canal Google Chat : nom du volume / de l'archive, expéditeur, destinataire et date/heure d'expiration.

8\. Thomas déclenche le téléchargement ; son agent récupère directement l'archive depuis S3.

9\. Après restauration ou téléchargement réussi, le transfert temporaire peut être considéré comme terminé.

# **7\. Principes d’architecture**

Les règles clés à respecter :

• Séparation stricte des responsabilités entre Docker local, orchestration centrale et stockage S3.

• Aucun credential S3 permanent distribué aux navigateurs ou aux utilisateurs.

• Le backend ne transporte jamais les gros binaires.

• Aucun stockage relationnel imposé pour le MVP.

• S3 réservé aux archives temporaires de volumes.

• Identifiants techniques simples pour les utilisateurs et les transferts.

• Suppression automatique des objets S3 après une durée courte configurable.

• Le webhook Google Chat est un secret serveur et n'est jamais exposé au navigateur ni aux agents locaux.  
• La notification Google Chat n'est envoyée qu'après confirmation de la disponibilité de l'archive dans S3.  
• Application exclusivement interne en V1.

# **8\. Cycle de vie d’un transfert**

L’état courant d’un transfert existe pendant son cycle de vie, mais le MVP n’impose pas qu’il soit conservé dans une base de données :

• created : transfert créé, aucun upload démarré.

• preparing : l’agent source prépare et compresse l’archive.

• uploading : upload S3 en cours.

• ready : archive disponible ; le destinataire peut la télécharger.

Lors du passage à l'état \`ready\`, le backend envoie une seule notification dans Google Chat. Cette notification doit refléter la date d'expiration calculée pour le transfert.  
Un échec du webhook Google Chat ne remet pas en cause la disponibilité du transfert : le transfert reste \`ready\`, l'erreur est journalisée et la notification peut être retentée sans recréer l'archive.  
• downloading : téléchargement côté destinataire en cours.

• completed : transfert téléchargé/restauré avec succès.

• failed : transfert en échec ; l’erreur technique est conservée pour diagnostic.

• expired : l’archive n’est plus disponible.

La V1 ne doit pas construire de mécanique complexe de persistance ou de reprise automatique. En cas d’échec, l’utilisateur peut relancer le transfert. Un historique durable, une reprise multipart ou un stockage persistant des états pourront être ajoutés seulement si les usages réels le justifient.

La suppression physique des archives doit être assurée par une règle de cycle de vie S3 lorsque cela est possible, afin que le nettoyage ne dépende pas d’un worker applicatif.

# **9\. API générique**

L’API manipule uniquement les ressources nécessaires au MVP : collègues connus et transferts temporaires. Les routes ci-dessous décrivent le contrat fonctionnel cible ; les noms exacts pourront évoluer pendant l’implémentation.

## **9.1 Utilisateurs / collègues**

| GET /users |
| :---- |

| 200 OK{  "items": \[    { "id": "thomas", "display\_name": "Thomas" }  \]} |
| :---- |

## **9.2 Volumes locaux**

La liste des volumes est fournie par l’agent local et n’a pas besoin de transiter par le backend pour être affichée à l’utilisateur.

| GET http://127.0.0.1:\<agent-port\>/volumes |
| :---- |

| 200 OK{  "items": \[    { "name": "mysql\_client\_x", "driver": "local" }  \]} |
| :---- |

## **9.3 Création d’un transfert**

| POST /transfers{  "recipient\_user\_id": "thomas",  "source\_volume\_name": "mysql\_client\_x"} |
| :---- |

| 201 Created{  "id": "tr\_123",  "status": "created",  "storage": {    "upload": "\<temporary-upload-mechanism\>"  },  "expires\_at": "\<ISO-8601\>"} |
| :---- |

Le format exact de \`storage.upload\` dépendra des capacités exposées par le module interne \`s3-node\`. Le contrat doit éviter d’exposer des credentials permanents.

## **9.4 Changement d’état**

| PATCH /transfers/{transferId}{  "status": "ready",  "archive\_size": 408021221} |
| :---- |

Le backend valide les transitions autorisées afin d’éviter qu’un agent puisse placer arbitrairement un transfert dans un état incohérent.

## **9.5 Transferts reçus**

| GET /transfers?direction=incoming\&status=ready |
| :---- |

| 200 OK{  "items": \[    {      "id": "tr\_123",      "sender": { "id": "mael", "display\_name": "Maël" },      "volume\_name": "mysql\_client\_x",      "archive\_size": 408021221,      "expires\_at": "\<ISO-8601\>"    }  \]} |
| :---- |

## **9.6 Téléchargement**

| POST /transfers/{transferId}/download |
| :---- |

| 200 OK{  "storage": {    "download": "\<temporary-download-mechanism\>"  }} |
| :---- |

Le binaire est ensuite téléchargé directement par l’agent depuis S3. La configuration technique S3 n’est jamais exposée inutilement à l’interface web.

## **9.7 Notification Google Chat**

Le backend publie une notification HTTP POST vers le webhook configuré dans la variable d'environnement \`GOOGLE\_CHAT\_WEBHOOK\_URL\` uniquement lorsque le transfert passe à l'état \`ready\`.  
Contenu minimal du message :  
• Nom du volume Docker / nom de l’archive mise à disposition.  
• Nom de l’expéditeur.  
• Nom du destinataire.  
• Date et heure d’expiration de la mise à disposition.  
Exemple : \`Maël a mis à disposition mysql\_client\_x pour Thomas. Disponible jusqu'au 24/09/2026 à 15:30, puis suppression automatique du stockage S3.\`  
La date affichée correspond à l'expiration fonctionnelle calculée selon la politique de rétention configurée ; la suppression physique de l'objet reste gérée par S3.

# **10\. Interface utilisateur V1**

L’objectif de la V1 est de rendre l’opération évidente pour un développeur sans lui demander de manipuler des commandes Docker.

• Colonne ou zone listant les volumes Docker présents sur la machine locale.

• Zone listant les collègues autorisés.

• Drag & drop d’un volume sur un collègue pour déclencher l’envoi.

• Progression de préparation et d’upload visible côté expéditeur.

• Notification visible côté destinataire lorsque le transfert est prêt.

• Action Télécharger / Restaurer déclenchée explicitement par le destinataire.

• Affichage clair des erreurs et de la date d’expiration.

Le drag & drop est une interaction d’interface ; il n’implique pas un déplacement direct de données entre navigateurs. Le traitement réel reste piloté par les agents et le backend.

# **11\. Sécurité et contraintes internes**

Même dans un réseau interne avec des utilisateurs connus, quelques garde-fous restent nécessaires car un volume peut contenir des données applicatives sensibles.

• Chaque agent doit être associé à une machine et à un utilisateur connus.

• Le service central doit vérifier que le destinataire existe dans la configuration des collègues autorisés.

• Les URLs ou mécanismes d’accès S3 doivent être temporaires et limités à un objet précis.

• Les archives expirent rapidement et ne doivent pas devenir un stockage permanent.

• Les erreurs essentielles doivent être journalisées dans les logs de l’application et de l’agent ; aucun historique métier durable n’est requis en V1.

• L'URL du webhook Google Chat est stockée uniquement en variable d'environnement côté serveur et doit être considérée comme un secret.  
• Le contenu de la notification ne doit contenir aucune URL S3 signée ni credential ; il ne contient que les métadonnées utiles au transfert.  
• L’agent ne doit exposer son API locale que sur l’interface nécessaire, idéalement localhost, sauf besoin réseau explicitement validé.

# **12\. Périmètre V1 et tests**

La V1 couvre uniquement :

• Configuration statique des collègues via un fichier JSON.

• Agent Bun/TypeScript capable de lister les volumes Docker locaux.

• Drag & drop d’un volume vers un collègue.

• Création, compression et upload direct de l’archive vers S3.

• Suivi temporaire de l’état nécessaire au déroulement du transfert.

• Notification dans un canal Google Chat dédié après confirmation de l'upload S3.

• Configuration du webhook Google Chat via variable d'environnement serveur.  
• Message contenant expéditeur, destinataire, nom du volume / de l'archive et date/heure d'expiration.  
• Téléchargement direct depuis S3 et restauration locale du volume.

• Expiration automatique des archives.

• Utilisation du module interne NWB \`s3-node\` pour l’intégration S3.

Les tests doivent au minimum couvrir :

• Listing de volumes Docker.

• Export puis restauration d’un petit volume de référence.

• Transfert complet entre deux utilisateurs de test.

• Échec d’upload et download, puis relance manuelle.

• Collision de nom d’un volume à la réception.

• Expiration d’un transfert.

• Envoi d'une notification Google Chat uniquement après passage du transfert à \`ready\`.  
• Vérification du contenu du message : expéditeur, destinataire, nom du volume / de l'archive et expiration.  
• Échec du webhook Google Chat sans blocage du transfert disponible dans S3.  
• Refus d’un destinataire inconnu de la configuration.

# **13\. Hors périmètre V1**

• Partage public ou avec des utilisateurs externes.

• Synchronisation continue de volumes.

• Historique/versioning de snapshots.

• Peer-to-peer direct entre deux postes.

• Transfert des images ou containers Docker.

• Découverte automatique de projets complets ou de docker-compose.

• Gestion avancée des droits par équipe ou projet.

• Reprise multipart sophistiquée et delta entre deux snapshots.

# **14\. Conclusion**

Cette architecture permet :

• Une expérience utilisateur très simple autour du drag & drop.

• Un accès Docker limité aux agents locaux.

• Un backend central léger qui orchestre sans transporter les données lourdes.

• Un coût de stockage maîtrisé grâce à S3 et à une rétention courte.

• Une architecture sans base de données obligatoire pour le MVP.

• Une base technique suffisamment simple pour être développée rapidement tout en restant extensible.

La V1 privilégie volontairement un périmètre réduit : connaître les volumes d'une machine, choisir un collègue, envoyer une archive via S3, publier une notification dans le canal Google Chat dédié une fois l'upload confirmé, puis permettre au destinataire de récupérer le volume. Toute évolution supplémentaire doit répondre à un besoin observé après utilisation réelle.

# **15\. Évolutions possibles**

Ces évolutions sont hors du périmètre V1 et ne constituent pas des engagements :

• Persistance et historique durable des transferts si un besoin réel apparaît.

• Notifications système natives via une application desktop dédiée.

• Gestion d’équipes ou de groupes de destinataires.

• Snapshots nommés et versionnés.

• Reprise d’upload/download pour les très gros volumes.

• Chiffrement applicatif de l’archive avant envoi dans S3 si le contexte le nécessite.

• Détection ou masquage de volumes sensibles selon des règles internes.

• Partage d’un ensemble de volumes liés à un même projet.

# **16\. Découpage en tâches indépendantes et stratégie TDD**

**Objectif de cette section.** Transformer le périmètre V1 en lots de travail aussi indépendants que possible, afin qu’une tâche puisse être prise en charge, testée et validée sans nécessiter l’implémentation préalable des autres composants. Les frontières Docker, S3, backend central et Google Chat doivent être simulables par des mocks, fakes ou fixtures dans les tests.  
**Règle TDD globale — obligatoire.** Le développement se déroule en deux phases strictes. Phase 1 : écrire l’intégralité des tests décrits dans les tâches ci-dessous, ainsi que les fixtures et doubles de test nécessaires ; aucun code de production n’est ajouté pendant cette phase. Phase 2 : seulement lorsque tous les tests prévus existent et échouent pour les bonnes raisons, commencer l’implémentation, tâche par tâche, jusqu’à rendre la suite verte.  
**Règle de stabilité des tests.** Un test ne doit pas être affaibli, supprimé ou réécrit pour s’adapter à l’implémentation. Si le contrat fonctionnel change, la modification du test doit être explicite et justifiée comme un changement de spécification.  
**Définition de « tâche indépendante ».** Chaque tâche doit pouvoir être développée contre des contrats stables et des doubles de test. Elle ne doit pas imposer qu’un autre lot soit déjà codé. Les tests d’intégration de bout en bout sont regroupés dans une tâche de qualification séparée et ne bloquent pas l’implémentation isolée des autres lots.

## **16.1 Tâche 1 — Charger et exposer la configuration des collègues**

**Objectif.** Lire la configuration statique des collaborateurs autorisés et exposer uniquement les informations nécessaires au MVP.  
**Tests à écrire avant toute implémentation :**  
• le chargement d’un users.json valide retourne les utilisateurs attendus avec un identifiant stable et un nom d’affichage ;  
• un fichier absent, illisible ou invalide produit une erreur explicite et journalisable ;  
• GET /users retourne la collection attendue sans exposer d’information technique inutile ;  
• un destinataire absent de la configuration est refusé lors d’une demande de transfert.  
**La tâche est considérée comme OK lorsque :**  
• tous les tests de configuration et de GET /users passent ;  
• aucune base de données ni système d’inscription n’est introduit ;  
• la validation d’un destinataire inconnu est couverte et fonctionnelle.  
**Isolation / remarque.** Le stockage du fichier avec l’application ou dans S3 reste un détail de déploiement ; le test porte sur le contrat de lecture, pas sur son emplacement physique.

## **16.2 Tâche 2 — Lister les volumes Docker locaux dans l’agent**

**Objectif.** Permettre à l’agent Bun/TypeScript de découvrir dynamiquement les volumes du Docker Engine local et de les exposer à l’interface.  
**Tests à écrire avant toute implémentation :**  
• une réponse Docker contenant plusieurs volumes est convertie vers le contrat attendu par GET /volumes ;  
• le nom et le driver d’un volume sont remontés correctement ;  
• les labels ou la taille sont tolérés lorsqu’ils sont disponibles mais leur absence ne casse pas la réponse ;  
• une erreur ou une indisponibilité du Docker Engine retourne une erreur contrôlée ;  
• aucune liste de volumes n’est persistée par l’agent ou le backend.  
**La tâche est considérée comme OK lorsque :**  
• GET http://127.0.0.1:\<agent-port\>/volumes reflète l’état courant du Docker Engine ;  
• les erreurs Docker sont explicites et testées ;  
• le navigateur n’accède jamais directement au socket Docker.  
**Isolation / remarque.** Le Docker Engine est mocké dans les tests unitaires ; un test d’intégration local avec Docker réel peut être ajouté sans être requis pour coder cette tâche.

## **16.3 Tâche 3 — Créer et compresser une archive de volume**

**Objectif.** Produire, à partir d’un volume Docker sélectionné, une archive cohérente et compressée au format attendu pour le transfert temporaire.  
**Tests à écrire avant toute implémentation :**  
• un petit volume de référence contenant plusieurs fichiers peut être exporté ;  
• le contenu de l’archive correspond au contenu du volume de référence ;  
• l’archive obtenue est lisible et décompressable ;  
• une erreur d’accès au volume ou de création d’archive échoue proprement sans déclarer le transfert prêt ;  
• les fichiers temporaires créés pendant la préparation sont nettoyés après succès ou échec.  
**La tâche est considérée comme OK lorsque :**  
• le test d’export d’un volume de référence passe de manière déterministe ;  
• l’archive produite est compatible avec l’étape de restauration ;  
• les erreurs de préparation sont propagées sans upload partiel considéré comme réussi.  
**Isolation / remarque.** L’upload S3 est mocké : cette tâche s’arrête à la production de l’archive locale.

## **16.4 Tâche 4 — Créer le transfert temporaire côté backend**

**Objectif.** Implémenter le contrat POST /transfers : validation du destinataire, création d’un identifiant technique temporaire, statut initial et expiration fonctionnelle.  
**Tests à écrire avant toute implémentation :**  
• une demande valide crée un identifiant de transfert unique et retourne le statut created ;  
• le nom du volume source et le destinataire sont associés au transfert temporaire ;  
• un destinataire inconnu est refusé ;  
• expires\_at est calculé à partir de la durée de rétention configurée ;  
• la création d’un transfert ne nécessite aucune table user, machine ou transfer persistante.  
**La tâche est considérée comme OK lorsque :**  
• POST /transfers respecte le contrat fonctionnel cible ;  
• les validations et l’expiration sont couvertes par les tests ;  
• l’état nécessaire au transfert reste temporaire et sans base de données imposée.  
**Isolation / remarque.** L’accès S3 retourné peut être remplacé par un fake dans cette tâche ; sa génération réelle appartient à la tâche suivante.

## **16.5 Tâche 5 — Fournir un mécanisme d’upload S3 temporaire et limité**

**Objectif.** Utiliser le module interne NWB s3-node pour permettre à l’agent source d’envoyer directement l’archive dans S3 sans faire transiter le binaire par le backend.  
**Tests à écrire avant toute implémentation :**  
• la clé de stockage suit la forme docker-volume-transfers/{transferId}/volume.tar.zst ;  
• le nom réel du volume n’est pas utilisé comme clé S3 ;  
• le mécanisme fourni est temporaire et limité à l’objet du transfert ;  
• aucun credential S3 permanent n’est exposé au navigateur ou à l’utilisateur ;  
• le backend n’accepte pas le binaire de l’archive comme payload de transfert.  
**La tâche est considérée comme OK lorsque :**  
• un agent peut obtenir les informations nécessaires à l’upload via le contrat du transfert ;  
• la clé S3 est déterministe à partir du transferId et sans collision liée au nom de volume ;  
• les tests prouvent que le backend reste hors du chemin des gros binaires.  
**Isolation / remarque.** Les capacités exactes de s3-node déterminent la forme concrète de storage.upload ; le test doit figer ce contrat avant l’implémentation.

## **16.6 Tâche 6 — Valider la machine à états d’un transfert**

**Objectif.** Centraliser et tester les transitions de statut afin qu’un agent ne puisse pas placer arbitrairement un transfert dans un état incohérent.  
**Tests à écrire avant toute implémentation :**  
• les transitions attendues created → preparing → uploading → ready sont acceptées ;  
• les passages vers downloading puis completed sont acceptés pour le flux de réception ;  
• un échec peut placer le transfert dans failed ;  
• un transfert expiré peut être représenté par expired ;  
• les sauts incohérents, retours arrière non prévus et statuts inconnus sont refusés ;  
• PATCH /transfers/{transferId} applique ces règles.  
**La tâche est considérée comme OK lorsque :**  
• toutes les transitions autorisées et interdites sont décrites par des tests ;  
• PATCH /transfers/{transferId} ne peut pas contourner la machine à états ;  
• aucune notification Google Chat n’est déclenchée avant le passage valide à ready.  
**Isolation / remarque.** Google Chat, S3 et l’agent sont mockés : cette tâche ne teste que la logique d’état.

## **16.7 Tâche 7 — Uploader l’archive directement depuis l’agent**

**Objectif.** Faire exécuter à l’agent source l’upload direct de l’archive vers S3 et remonter la progression ainsi que le résultat au backend.  
**Tests à écrire avant toute implémentation :**  
• l’agent utilise le mécanisme temporaire reçu pour envoyer l’archive sans passer par le backend ;  
• la progression peut être remontée pendant la préparation et l’upload ;  
• un upload réussi est confirmé au backend avant tout passage à ready ;  
• un échec d’upload produit failed ou une erreur équivalente sans notification ready ;  
• une relance manuelle peut démarrer un nouveau transfert sans mécanisme de reprise complexe imposé.  
**La tâche est considérée comme OK lorsque :**  
• un upload simulé de bout en bout agent → S3 fake → backend fake passe ;  
• les erreurs d’upload sont visibles et ne produisent pas de faux succès ;  
• le serveur applicatif ne transporte jamais l’archive.  
**Isolation / remarque.** Le backend et S3 sont remplacés par des fakes ; la tâche peut être codée sans que le backend réel soit disponible.

## **16.8 Tâche 8 — Envoyer la notification Google Chat au passage à ready**

**Objectif.** Publier une notification dans le canal Google Chat dédié uniquement après confirmation que l’archive est disponible dans S3.  
**Tests à écrire avant toute implémentation :**  
• aucune notification n’est envoyée pour created, preparing ou uploading ;  
• une seule notification est envoyée lors du passage valide à ready ;  
• le message contient l’expéditeur, le destinataire, le nom du volume ou de l’archive et la date/heure d’expiration ;  
• le webhook est lu depuis GOOGLE\_CHAT\_WEBHOOK\_URL côté serveur ;  
• le message ne contient ni URL S3 signée ni credential ;  
• un échec HTTP du webhook laisse le transfert à ready, journalise l’erreur et autorise une nouvelle tentative sans recréer l’archive.  
**La tâche est considérée comme OK lorsque :**  
• la suite de tests couvre succès, non-déclenchement prématuré et panne du webhook ;  
• la disponibilité du transfert n’est jamais annulée par une panne Google Chat ;  
• le secret du webhook n’est exposé ni au navigateur ni à l’agent.  
**Isolation / remarque.** Le webhook Google Chat est intégralement mocké dans les tests ; aucun appel réel n’est requis.

## **16.9 Tâche 9 — Lister les transferts reçus prêts au téléchargement**

**Objectif.** Permettre à un destinataire de voir uniquement les transferts entrants encore disponibles et au statut ready.  
**Tests à écrire avant toute implémentation :**  
• GET /transfers?direction=incoming\&status=ready retourne les transferts du destinataire demandé ;  
• chaque entrée contient l’identifiant, l’expéditeur, le nom du volume, la taille connue et expires\_at ;  
• les transferts non ready, expirés ou destinés à un autre utilisateur ne sont pas retournés ;  
• une absence de transfert retourne une collection vide sans erreur.  
**La tâche est considérée comme OK lorsque :**  
• le contrat de réponse de la section API est respecté ;  
• le filtrage par destinataire et statut est couvert ;  
• aucune persistance durable n’est requise pour produire la liste pendant le cycle de vie du transfert.  
**Isolation / remarque.** L’état temporaire du backend est injecté sous forme de fake ou de repository en mémoire pour garder la tâche indépendante.

## **16.10 Tâche 10 — Fournir un mécanisme de téléchargement S3 temporaire**

**Objectif.** Implémenter POST /transfers/{transferId}/download afin de donner au bon destinataire un accès temporaire et limité à l’archive correspondante.  
**Tests à écrire avant toute implémentation :**  
• un transfert ready et non expiré retourne un mécanisme de téléchargement temporaire ;  
• un transfert expiré, failed ou non ready est refusé ;  
• un utilisateur qui n’est pas le destinataire est refusé ;  
• le mécanisme est limité à l’objet S3 correspondant au transferId ;  
• aucun credential permanent n’est renvoyé à l’interface.  
**La tâche est considérée comme OK lorsque :**  
• le contrat storage.download est utilisable par l’agent destinataire ;  
• les contrôles d’état, d’expiration et de destinataire passent ;  
• le téléchargement réel reste direct entre l’agent et S3.  
**Isolation / remarque.** S3 est mocké ; la tâche ne dépend pas de l’implémentation du client de téléchargement de l’agent.

## **16.11 Tâche 11 — Télécharger l’archive depuis S3 dans l’agent destinataire**

**Objectif.** Faire récupérer l’archive directement par l’agent du destinataire à partir du mécanisme temporaire fourni par le backend.  
**Tests à écrire avant toute implémentation :**  
• l’agent télécharge l’archive depuis un endpoint S3 simulé sans faire transiter le binaire par le backend ;  
• la progression du téléchargement peut être exposée à l’interface ;  
• une erreur réseau ou S3 est remontée proprement ;  
• une relance manuelle est possible après échec ;  
• un fichier incomplet ou invalide n’est pas transmis à l’étape de restauration comme s’il était valide.  
**La tâche est considérée comme OK lorsque :**  
• un téléchargement réussi produit une archive locale exploitable ;  
• les cas d’échec sont couverts et ne marquent pas le transfert completed ;  
• le backend reste absent du chemin binaire.  
**Isolation / remarque.** Le backend et S3 sont simulés. La restauration Docker appartient à la tâche suivante.

## **16.12 Tâche 12 — Restaurer une archive dans un volume Docker local**

**Objectif.** Restaurer explicitement une archive reçue dans un volume Docker local sans écraser silencieusement un volume existant.  
**Tests à écrire avant toute implémentation :**  
• une archive de référence peut être restaurée dans un nouveau volume et restitue les fichiers attendus ;  
• une archive corrompue ou non lisible est refusée ;  
• une collision avec un nom de volume existant est détectée avant écriture destructive ;  
• le comportement choisi pour la collision est fixé par le test : refus, renommage ou confirmation explicite, mais jamais écrasement silencieux ;  
• une restauration réussie permet ensuite de marquer le transfert completed.  
**La tâche est considérée comme OK lorsque :**  
• le test export puis restauration d’un petit volume de référence passe ;  
• le contenu restauré est identique au contenu attendu ;  
• la collision de nom est gérée sans perte silencieuse de données.  
**Isolation / remarque.** Cette tâche peut travailler avec une archive fixture produite à l’avance ; elle n’a pas besoin que l’export réel de la tâche 3 soit déjà implémenté.

## **16.13 Tâche 13 — Gérer l’expiration fonctionnelle et le nettoyage S3**

**Objectif.** Appliquer une durée de rétention courte, empêcher l’utilisation d’un transfert expiré et déléguer la suppression physique des objets à une règle de cycle de vie S3.  
**Tests à écrire avant toute implémentation :**  
• expires\_at est calculé de façon déterministe à partir de la configuration de rétention ;  
• un transfert passé après expires\_at est considéré comme expired ou indisponible ;  
• aucun nouveau download n’est délivré après expiration ;  
• le message Google Chat affiche la même expiration fonctionnelle ;  
• aucun worker applicatif de suppression physique n’est nécessaire lorsque la règle de cycle de vie S3 est disponible.  
**La tâche est considérée comme OK lorsque :**  
• les tests avec horloge contrôlée couvrent avant, à et après l’expiration ;  
• l’accès applicatif cesse à la date prévue ;  
• la configuration de cycle de vie S3 est documentée ou vérifiable indépendamment du code métier.  
**Isolation / remarque.** Utiliser une horloge injectée/fake dans les tests afin d’éviter les attentes réelles et de garder les tests déterministes.

## **16.14 Tâche 14 — Afficher volumes et collègues puis déclencher le drag & drop**

**Objectif.** Construire l’interaction V1 permettant de voir les volumes locaux, voir les collègues autorisés et glisser un volume sur un collègue pour demander un transfert.  
**Tests à écrire avant toute implémentation :**  
• l’interface affiche les volumes fournis par l’agent local ;  
• l’interface affiche les collègues fournis par le backend ;  
• un drag & drop d’un volume sur un collègue déclenche exactement une demande de création de transfert avec recipient\_user\_id et source\_volume\_name ;  
• une erreur de chargement des volumes ou des collègues est visible ;  
• aucun accès direct au socket Docker, à S3 ou au webhook Google Chat n’est effectué depuis le navigateur.  
**La tâche est considérée comme OK lorsque :**  
• les composants UI passent leurs tests avec API agent/backend mockées ;  
• le drag & drop produit la requête attendue ;  
• les erreurs initiales sont compréhensibles par l’utilisateur.  
**Isolation / remarque.** La tâche ne dépend pas du backend ou de l’agent réels : les deux contrats HTTP sont simulés.

## **16.15 Tâche 15 — Afficher progression, erreurs et actions de réception**

**Objectif.** Compléter l’interface avec la progression de préparation/upload/download, les erreurs, l’expiration et les actions explicites Télécharger / Restaurer.  
**Tests à écrire avant toute implémentation :**  
• les statuts preparing, uploading, ready, downloading, completed, failed et expired ont un rendu testable ;  
• la progression disponible est affichée côté expéditeur ou destinataire ;  
• un transfert ready propose l’action de téléchargement au destinataire ;  
• la restauration reste une action explicite de l’utilisateur ;  
• la date d’expiration est visible ;  
• un échec permet de relancer manuellement le flux prévu sans reprise automatique sophistiquée.  
**La tâche est considérée comme OK lorsque :**  
• chaque état fonctionnel important possède au moins un test UI ;  
• les actions visibles sont cohérentes avec le statut du transfert ;  
• aucune action interdite n’est proposée pour un transfert expiré ou en échec non relancé.  
**Isolation / remarque.** Les données de transfert sont fournies par des fixtures ; aucun transfert réel n’est requis pour développer cette tâche.

## **16.16 Tâche 16 — Vérifier les frontières de sécurité du MVP**

**Objectif.** Tester explicitement les garde-fous transverses décrits dans l’architecture sans ajouter une gestion de droits plus complexe que le périmètre V1.  
**Tests à écrire avant toute implémentation :**  
• un destinataire inconnu est refusé ;  
• le webhook Google Chat reste uniquement dans l’environnement serveur ;  
• les réponses navigateur ne contiennent pas de credentials S3 permanents ;  
• les mécanismes S3 temporaires sont limités à un objet de transfert ;  
• l’API de l’agent est liée à localhost par défaut ou à l’interface explicitement validée ;  
• les notifications ne contiennent ni URL S3 signée ni secret ;  
• les erreurs essentielles sont journalisables sans exiger d’historique métier durable.  
**La tâche est considérée comme OK lorsque :**  
• tous les tests de non-exposition de secrets et de contrôle du destinataire passent ;  
• aucun secret serveur n’apparaît dans les payloads destinés au navigateur ou à l’agent ;  
• les garde-fous restent compatibles avec une application exclusivement interne en V1.  
**Isolation / remarque.** Cette tâche est une suite de tests transverses exécutée contre des composants isolés ; elle ne nécessite pas un déploiement complet.

## **16.17 Tâche 17 — Qualifier le flux complet entre deux utilisateurs de test**

**Objectif.** Assembler les composants déjà testés isolément pour vérifier le scénario fonctionnel V1 complet, sans transformer cette qualification en dépendance de développement des autres tâches.  
**Tests à écrire avant toute implémentation :**  
• un utilisateur source voit un volume de référence et un destinataire de test ;  
• le drag & drop crée un transfert ;  
• l’agent source prépare l’archive et l’upload directement dans un stockage S3 de test ;  
• le backend ne marque ready qu’après confirmation de disponibilité ;  
• une seule notification Google Chat simulée est produite avec les bonnes métadonnées ;  
• le destinataire voit le transfert ready, télécharge l’archive et la restaure ;  
• le contenu du volume restauré correspond au volume source ;  
• les variantes échec d’upload, échec de download et expiration sont exécutées avec relance manuelle lorsque prévu.  
**La tâche est considérée comme OK lorsque :**  
• le scénario nominal source → S3 → destinataire passe sans relais binaire du backend ;  
• les scénarios d’échec minimum exigés par le périmètre V1 sont verts ;  
• les tests démontrent le respect des frontières Docker local / backend central / S3 / Google Chat.  
**Isolation / remarque.** Cette tâche est la qualification finale. Elle valide l’intégration des contrats mais ne doit pas être utilisée pour masquer l’absence de tests unitaires ou de composants.

## **16.18 Ordre d’exécution du développement**

• Phase 1 — Tests uniquement : écrire les tests des tâches 1 à 17, les fixtures, les mocks/fakes et les contrats de test. Aucun code de production n’est écrit pendant cette phase.  
• Gate TDD : la phase d’implémentation ne commence que lorsque tous les tests prévus existent, sont exécutables et échouent parce que les comportements ne sont pas encore implémentés, et non à cause d’un setup cassé.  
• Phase 2 — Implémentation : prendre les tâches dans n’importe quel ordre compatible avec l’organisation de l’équipe, faire passer leurs tests sans modifier leur intention, puis refactorer en gardant la suite verte.  
• Qualification : exécuter ensuite la tâche 17 avec les composants réels ou leurs environnements de test afin de valider le flux complet.  
**Definition of Done commune.** Une tâche n’est terminée que si tous ses tests pré-écrits sont verts, aucun test nécessaire n’est ignoré, les erreurs prévues sont couvertes, les frontières de sécurité applicables sont respectées et l’implémentation n’introduit pas de composant hors périmètre V1 sans besoin démontré.