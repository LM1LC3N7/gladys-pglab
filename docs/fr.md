# PG LAB Electronics pour Gladys

Cette intégration lit et commande les cartes **PG LAB Electronics E-Board**
via un **broker MQTT** de votre réseau local : leurs relais, leurs volets,
et la température et la tension du processeur de la carte. Rien ne passe
par Internet.

> **Jamais testée avec une vraie carte.**
> Cette intégration n'a jamais été testée avec une vraie carte PG LAB : elle
> suit le protocole MQTT de pypglab, la bibliothèque écrite par PG LAB
> Electronics pour Home Assistant. Non officielle, sans lien avec PG LAB
> Electronics. Vos retours sont les bienvenus.

## Ce qu'il faut

1. **Un broker MQTT** que les cartes et Gladys peuvent joindre. Deux choix :
   - **votre propre broker** (Mosquitto sur un Raspberry Pi, un NAS…) :
     saisissez son adresse IP ;
   - **le broker de Gladys** : dans Gladys, ouvrez **Intégrations → MQTT**,
     démarrez le broker proposé et notez son utilisateur et son mot de
     passe. Saisissez ensuite `mqtt://<adresse IP de la machine Gladys>:1883`
     (l'écran de configuration affiche l'adresse qu'il devine). **Jamais
     `localhost`** : l'intégration tourne dans son propre conteneur, où
     `localhost` est le conteneur lui-même. Un pare-feu sur la machine
     Gladys doit laisser passer le port 1883.
2. **Chaque carte réglée sur ce broker** : dans les réglages MQTT de
   l'E-Board (sa page web), saisissez le même broker, utilisateur et mot de
   passe. La carte s'annonce alors sous `pglab/discovery/<id>/config` et
   publie ses états sous `pglab/<nom>/…`.

Quiconque peut publier sur le broker peut se faire passer pour une carte :
protégez le broker par un mot de passe et gardez-le sur votre réseau local.

## Mise en route

1. Installez l'intégration, puis ouvrez son onglet **Configuration**.
2. Saisissez l'adresse du broker, et son utilisateur et son mot de passe
   s'il en demande. Le mot de passe est gardé par Gladys dans sa base,
   jamais réaffiché, envoyé seulement à votre broker.
3. Cliquez sur **Tester la connexion** : elle connecte (ou reconnecte)
   l'unique session de l'intégration et compte les cartes qui se sont
   annoncées.
4. Ouvrez l'onglet **Découverte** et créez les appareils voulus.

## Ce que vous obtenez

| Appareil                  | Fonctions                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------- |
| La carte                  | température de la carte (°C), tension du processeur (V), en lecture seule             |
| Chaque volet              | ouvrir / fermer / arrêter (un volet, jamais un interrupteur)                          |
| Chaque relais, par défaut | son état (lecture seule), boutons **Allumer** et **Éteindre** (désactivés par défaut) |
| Chaque relais déclaré sûr | un interrupteur (marche/arrêt)                                                        |

Un relais peut alimenter n'importe quoi : une lampe, mais aussi un
circulateur, la chaudière, un radiateur, un congélateur, un portail. Un
« éteins tout / allume tout » d'un assistant vocal ou d'une scène atteint
chaque interrupteur. Un relais n'est donc un interrupteur que si **vous** le
déclarez sûr :

- **Relais déclarés sûrs** : les numéros des relais (paramètre
  `PGLAB_RELAY` dans l'onglet Découverte), par exemple `4, 5`. Avec
  plusieurs cartes, écrivez `id-carte:numéro` (paramètre `PGLAB_ID`), par
  exemple `DD53AC85:5` : un numéro seul n'est alors appliqué nulle part (le
  statut le dit, et nomme aussi un id qui ne correspond à aucune carte
  acceptée).
- **Autoriser les boutons « Allumer » / « Éteindre »** : désactivé par
  défaut. Tant qu'il l'est, les boutons des relais non déclarés sûrs
  n'envoient rien.

Ce qu'annonce une carte ne fait jamais d'un relais un interrupteur, ni d'un
relais une sortie commandable : seuls ces deux réglages le font.

## Quand une carte change de configuration

L'intégration garde, pour chaque carte, la configuration que vous avez
acceptée : son nom (que portent ses topics MQTT), son type, son adresse MAC,
son nombre de volets et ses cartes d'extension (dans
`/data/pglab-state.json`, sans utilisateur ni mot de passe). Les appareils
et le routage des commandes en viennent, dès le démarrage, avant même que
la carte s'annonce. La première annonce d'une nouvelle carte est acceptée
telle quelle (64 cartes au plus).

Si une carte annonce ensuite un autre nom, type, adresse MAC ou une autre
configuration (d'autres volets, d'autres relais), elle **n'est pas
appliquée** : le statut le dit (pour un nom : « ancien → nouveau »), et tant
que vous n'avez pas cliqué sur **Scanner** dans l'onglet Découverte, ses
relais et l'ouverture de ses volets sont refusés. L'arrêt et la fermeture
partent quand même, sous le nom accepté et sous le nom annoncé : si le nom
annoncé est celui d'une autre carte, le volet de même numéro de cette carte
les reçoit aussi.

Cliquer sur **Scanner** accepte ce qu'annoncent les cartes à ce moment-là,
et oublie les cartes qui ne s'annoncent plus et n'ont aucun appareil dans
Gladys. Au-delà de 64 cartes acceptées, une nouvelle carte est ignorée et
le statut conseille un Scan.

Deux cartes du même nom partagent leurs topics : leurs états sont ignorés,
leurs relais et ouvertures refusés (l'arrêt et la fermeture les atteignent
toutes) jusqu'à ce que l'une d'elles soit renommée (ou que l'ancienne
annonce retenue d'une carte retirée soit effacée du broker) et que vous
Scanniez. Une carte remplacée par une neuve du même nom reste acceptée tant
qu'elle a des appareils dans Gladys : supprimez les appareils de l'ancienne
carte, puis Scannez.

## Quand une commande est refusée

Un **arrêt** ou une **fermeture** de volet n'est refusé que dans ces cas :

- le broker n'est pas connecté ;
- le volet ne fait pas partie de la configuration acceptée de sa carte (un
  Scan a accepté une configuration sans lui) ;
- la valeur reçue n'est pas une commande de volet ;
- la commande n'a pas pu partir dans les 3,5 s après le clic (rien
  n'attend devant elle, ce cas ne devrait pas arriver).

Une **ouverture** et les commandes de relais sont refusées dans ces cas, et
aussi :

- quand la carte ne s'est pas annoncée depuis la connexion au broker (après
  un redémarrage ou une reconnexion, jusqu'au retour de son annonce) ;
- quand elle a annoncé un autre nom, type, adresse MAC ou une autre
  configuration (jusqu'à un Scan) ;
- quand deux cartes portent le même nom ;
- pour un relais : quand il n'est pas déclaré sûr (son interrupteur), ou
  quand les boutons sont désactivés (ses boutons).

Une commande part une fois, jamais mise en attente par l'intégration quand
le broker est coupé. Quand la carte ne publie pas l'état attendu dans les
4 secondes environ, Gladys indique « envoyée, sans confirmation » : le
message est bien parti, et si le broker était figé il peut encore atteindre
la carte plus tard, au réveil du broker.

## Problèmes de connexion

- **Broker injoignable** : l'intégration réessaie toutes les 10 secondes,
  le statut dit pourquoi.
- **Identifiants refusés**, ou **broker qui ferme la connexion (ou ne
  répond pas) après avoir reçu les identifiants, deux fois de suite** (un
  certificat refusé ou une connexion jamais ouverte ne comptent pas : les
  identifiants ne sont pas partis, l'intégration réessaie) :
  l'intégration s'arrête pour de bon (même après un redémarrage) et ne
  réessaie rien d'elle-même. Enregistrez d'autres identifiants (ou un autre réglage TLS), ou cliquez
  sur **Tester la connexion** ; l'arrêt est levé dès qu'une connexion
  réussit. Sans utilisateur ni mot de passe, l'intégration continue
  d'essayer.
- **Un mot de passe sans utilisateur** : refusé dans la configuration (MQTT
  ne peut pas l'envoyer).
- **Aucune carte ne s'est annoncée** : vérifiez les réglages MQTT des cartes.
- Une carte qui n'a rien publié depuis 5 minutes est affichée injoignable
  (la carte envoie sa température environ chaque minute).
- **TLS** : laissez « Vérifier le certificat TLS » activé. Désactivé,
  l'utilisateur et le mot de passe partent à quiconque répond à l'adresse
  du broker : rien ne vérifie qui c'est.

## Limites

- MQTT sur TCP ou TLS (`mqtt://`, `mqtts://`), pas de WebSocket.
- L'intégration utilise MQTT 5 et demande au broker aucun message de plus
  de 8 Ko (Mosquitto le respecte). Un message de plus de 8 Ko qui arrive
  quand même coupe la connexion avant d'être lu (une reconnexion suit).
  Avec un broker sans MQTT 5, l'intégration utilise MQTT 3.1.1 et le dit
  dans le statut : un tel message coupe alors la connexion à chaque nouvel
  envoi (un énorme message retenu doit être effacé du broker).
- Les cartes E-Switch et E-Relay sont reconnues mais n'offrent encore rien
  (pypglab 0.0.5 ne leur donne aucune sortie).
- Les entrées de la carte ne sont pas proposées : pypglab n'a pas de topic
  pour elles.
- Les états gardés par le broker (retenus) sont ignorés : ils peuvent être
  anciens. Un relais affiche son état à son prochain changement.
- 64 cartes au plus, 64 relais et 32 volets par carte.
- Le temps depuis le dernier redémarrage de la carte (`rtime`) n'est pas
  proposé.
