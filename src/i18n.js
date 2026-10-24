// -----------------------------------------------------------------------------
// Runtime texts (English and French): device and feature names, the status
// of the integration, the answers of the button and the command errors.
// None of them ever carries the user name or the password of the broker.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

const FEATURE_NAMES = {
  [F.POWER]: both('On/off', 'Marche/arrêt'),
  [F.STATE]: both('State', 'État'),
  [F.TURN_ON]: both('Turn on', 'Allumer'),
  [F.TURN_OFF]: both('Turn off', 'Éteindre'),
  [F.SHUTTER]: both('Open / close', 'Ouvrir / fermer'),
  [F.TEMPERATURE]: both('Board temperature', 'Température de la carte'),
  [F.VOLTAGE]: both('Processor voltage', 'Tension du processeur'),
};

export const featureName = (role, language) =>
  word(FEATURE_NAMES[role] ?? both(role, role), language);

const KINDS = {
  relay: both('relay', 'relais'),
  shutter: both('shutter', 'volet'),
};

/**
 * "E-BOARD-DD53AC85 relay 5", "E-BOARD-DD53AC85 volet 0": at most 60
 * characters, the board part shortened so the suffix always stays.
 */
export const deviceName = (kind, boardName, n, language) => {
  const suffix = ` ${word(KINDS[kind], language)} ${n}`;
  return `${boardName.slice(0, 60 - suffix.length).trimEnd()}${suffix}`;
};

const BROKER_PROBLEMS = {
  empty: both('the address of the MQTT broker is empty', 'l’adresse du broker MQTT est vide'),
  invalid: both(
    'the address of the MQTT broker is not valid',
    'l’adresse du broker MQTT n’est pas valide',
  ),
  credentials: both(
    'type the user name and the password in their own fields, not in the address',
    'saisissez l’utilisateur et le mot de passe dans leurs champs, pas dans l’adresse',
  ),
};

const list = (items) => items.slice(0, 5).join(', ') + (items.length > 5 ? '…' : '');

/** The notes added to the "connected" status. */
function notes(n, language) {
  const en = language === 'en';
  const lines = [];
  if (n.invalid > 0) {
    lines.push(
      en
        ? `${n.invalid} entr(y/ies) ignored in "Relays declared safe" (expected a relay number such as 5, or board-id:5).`
        : `${n.invalid} entrée(s) ignorée(s) dans « Relais déclarés sûrs » (attendu : un numéro de relais comme 5, ou id-carte:5).`,
    );
  }
  if (n.ambiguous.length > 0) {
    lines.push(
      en
        ? `Not applied in "Relays declared safe": ${list(n.ambiguous)} (ambiguous with several boards: use board-id:number).`
        : `Non appliqué dans « Relais déclarés sûrs » : ${list(n.ambiguous)} (ambigu avec plusieurs cartes : utilisez id-carte:numéro).`,
    );
  }
  if (n.unknownIds.length > 0) {
    lines.push(
      en
        ? `Not applied in "Relays declared safe": no accepted board has the id ${list(n.unknownIds)} (parameter PGLAB_ID).`
        : `Non appliqué dans « Relais déclarés sûrs » : aucune carte acceptée n’a l’id ${list(n.unknownIds)} (paramètre PGLAB_ID).`,
    );
  }
  if (n.renamed.length > 0) {
    lines.push(
      en
        ? `Another name announced: ${list(n.renamed)}. Not applied: its relays and the opening of its shutters are refused until you click "Scan" in the Discovery tab (stop and close go under both names).`
        : `Autre nom annoncé : ${list(n.renamed)}. Non appliqué : ses relais et l’ouverture de ses volets sont refusés jusqu’à ce que vous cliquiez sur « Scanner » dans l’onglet Découverte (arrêt et fermeture partent sous les deux noms).`,
    );
  }
  if (n.pending.length > 0) {
    lines.push(
      en
        ? `The configuration of ${list(n.pending)} changed (type, shutters or relays): not applied, its relays and the opening of its shutters are refused until you click "Scan" in the Discovery tab.`
        : `La configuration de ${list(n.pending)} a changé (type, volets ou relais) : non appliquée, ses relais et l’ouverture de ses volets sont refusés jusqu’à ce que vous cliquiez sur « Scanner » dans l’onglet Découverte.`,
    );
  }
  if (n.conflicts.length > 0) {
    lines.push(
      en
        ? `Another MAC address answers for ${list(n.conflicts)}: its relays and the opening of its shutters are refused until you click "Scan" in the Discovery tab.`
        : `Une autre adresse MAC répond pour ${list(n.conflicts)} : ses relais et l’ouverture de ses volets sont refusés jusqu’à ce que vous cliquiez sur « Scanner » dans l’onglet Découverte.`,
    );
  }
  if (n.sharedNames.length > 0) {
    lines.push(
      en
        ? `Several boards are named ${list(n.sharedNames)}: their states are ignored and their relays and openings refused, stop and close reach all of them (rename one of them, or remove the old retained discovery from the broker, then Scan; a board replaced by a new one of the same name: delete the devices of the old board in Gladys, then Scan).`
        : `Plusieurs cartes s’appellent ${list(n.sharedNames)} : leurs états sont ignorés, leurs relais et ouvertures refusés, arrêt et fermeture les atteignent toutes (renommez l’une d’elles, ou effacez l’ancienne découverte retenue sur le broker, puis Scannez ; une carte remplacée par une neuve du même nom : supprimez dans Gladys les appareils de l’ancienne carte, puis Scannez).`,
    );
  }
  if (n.unsupported > 0) {
    lines.push(
      en
        ? `${n.unsupported} E-Switch / E-Relay board(s) seen: not supported yet.`
        : `${n.unsupported} carte(s) E-Switch / E-Relay vue(s) : pas encore prise(s) en charge.`,
    );
  }
  if (n.rejected > 0) {
    lines.push(
      en
        ? `${n.rejected} invalid discovery message(s) ignored.`
        : `${n.rejected} message(s) de découverte invalide(s) ignoré(s).`,
    );
  }
  if (n.ignored > 0) {
    lines.push(
      en
        ? `${n.ignored} new board(s) ignored: 64 boards are already accepted. Click "Scan" in the Discovery tab to forget the boards no longer announced and without a device.`
        : `${n.ignored} nouvelle(s) carte(s) ignorée(s) : 64 cartes sont déjà acceptées. Cliquez sur « Scanner » dans l’onglet Découverte pour oublier les cartes qui ne s’annoncent plus et sans appareil.`,
    );
  }
  if (n.protocol3) {
    lines.push(
      en
        ? 'The broker does not support MQTT 5: it does not limit the size of the messages it sends; a message over 8 KB cuts the connection.'
        : 'Le broker ne gère pas MQTT 5 : il ne limite pas la taille des messages qu’il envoie ; un message de plus de 8 Ko coupe la connexion.',
    );
  }
  return lines;
}

/** The connection status (shown in the Configuration screen). */
export const T = {
  problem: (problem) => {
    if (problem === 'broker:empty') {
      return both(
        'Not configured: type the address of your MQTT broker (the one your PG LAB boards publish to).',
        'Non configuré : saisissez l’adresse de votre broker MQTT (celui où publient vos cartes PG LAB).',
      );
    }
    if (problem?.startsWith('broker:')) {
      const p = BROKER_PROBLEMS[problem.slice(7)] ?? BROKER_PROBLEMS.invalid;
      return both(`Configuration: ${p.en}.`, `Configuration : ${p.fr}.`);
    }
    if (problem === 'user') {
      return both(
        'Configuration: a password without a user name cannot be sent to an MQTT broker: type the user name too.',
        'Configuration : un mot de passe sans utilisateur ne peut pas être envoyé à un broker MQTT : saisissez aussi l’utilisateur.',
      );
    }
    return both(
      'Configuration: the password is too long.',
      'Configuration : le mot de passe est trop long.',
    );
  },
  connecting: both('Connecting to the MQTT broker…', 'Connexion au broker MQTT…'),
  waiting: both(
    'Connected to the broker: waiting for the PG LAB boards to announce themselves…',
    'Connecté au broker : en attente de l’annonce des cartes PG LAB…',
  ),
  noBoard: both(
    'Connected to the broker, but no PG LAB board announced itself: check that your boards publish to this broker (MQTT settings of the board).',
    'Connecté au broker, mais aucune carte PG LAB ne s’est annoncée : vérifiez que vos cartes publient sur ce broker (réglages MQTT de la carte).',
  ),
  connected: (boards, devices, n) => {
    const head = both(
      `Connected: ${boards} PG LAB board(s), ${devices} device(s) offered in the Discovery tab.`,
      `Connecté : ${boards} carte(s) PG LAB, ${devices} appareil(s) proposé(s) dans l’onglet Découverte.`,
    );
    return both([head.en, ...notes(n, 'en')].join(' '), [head.fr, ...notes(n, 'fr')].join(' '));
  },
  unreachable: (reason) =>
    both(
      `MQTT broker unreachable (${reason}): next try in a moment.`,
      `Broker MQTT injoignable (${reason}) : nouvel essai dans un instant.`,
    ),
  lost: both(
    'Connection to the MQTT broker lost: reconnecting…',
    'Connexion au broker MQTT perdue : reconnexion…',
  ),
  stopped: both(
    'The MQTT broker refused the credentials: stopped, no new try by itself. Save other credentials, or use "Test the connection".',
    'Le broker MQTT a refusé les identifiants : arrêté, aucun nouvel essai automatique. Enregistrez d’autres identifiants, ou utilisez « Tester la connexion ».',
  ),
  refused: (reason) =>
    both(
      `The MQTT broker refused the credentials (${reason}): stopped, no new try by itself. Save other credentials, or use "Test the connection".`,
      `Le broker MQTT a refusé les identifiants (${reason}) : arrêté, aucun nouvel essai automatique. Enregistrez d’autres identifiants, ou utilisez « Tester la connexion ».`,
    ),
};

/** The answers of the "Test the connection" button. */
export const TEST = {
  ok: (boards, devices) =>
    both(
      `It works: ${boards} PG LAB board(s), ${devices} device(s) for Gladys.`,
      `Ça marche : ${boards} carte(s) PG LAB, ${devices} appareil(s) pour Gladys.`,
    ),
  refused: (reason) =>
    both(
      `The MQTT broker refused the credentials (${reason}).`,
      `Le broker MQTT a refusé les identifiants (${reason}).`,
    ),
  tooSoon: both(
    'Already tested a few seconds ago: try again in a moment.',
    'Déjà testé il y a quelques secondes : réessayez dans un instant.',
  ),
};

/** The errors of a command (shown by Gladys when a command fails). */
export const ERRORS = {
  readOnly: both('This feature cannot be controlled.', 'Cette fonction ne se commande pas.'),
  badValue: both('Value not accepted.', 'Valeur refusée.'),
  notConnected: both(
    'The MQTT broker is not connected: the command was not sent.',
    'Le broker MQTT n’est pas connecté : la commande n’a pas été envoyée.',
  ),
  notAnnounced: both(
    'This board has not announced itself on the broker since the connection: nothing sent (only a stop or a close of a shutter goes before).',
    'Cette carte ne s’est pas annoncée sur le broker depuis la connexion : rien n’a été envoyé (seuls l’arrêt et la fermeture d’un volet partent avant).',
  ),
  notAccepted: both(
    'This device is not (or no longer) part of the configuration accepted for its board: nothing sent.',
    'Cet appareil ne fait pas (ou plus) partie de la configuration acceptée pour sa carte : rien n’a été envoyé.',
  ),
  renamed: both(
    'The board announced another name: click "Scan" in the Discovery tab to accept it. Nothing sent.',
    'La carte a annoncé un autre nom : cliquez sur « Scanner » dans l’onglet Découverte pour l’accepter. Rien n’a été envoyé.',
  ),
  unsafeOutput: both(
    'This relay is not declared safe in the configuration: nothing sent. Use its "Turn on" / "Turn off" buttons, or declare it safe.',
    'Ce relais n’est pas déclaré sûr dans la configuration : rien n’a été envoyé. Utilisez ses boutons « Allumer » / « Éteindre », ou déclarez-le sûr.',
  ),
  buttonsDisabled: both(
    'The "Turn on" / "Turn off" buttons are off: allow them in the configuration of the integration. Nothing sent.',
    'Les boutons « Allumer » / « Éteindre » sont désactivés : autorisez-les dans la configuration de l’intégration. Rien n’a été envoyé.',
  ),
  layoutChanged: both(
    'The board published another configuration (type, shutters or relays): click "Scan" in the Discovery tab to accept it. Nothing sent.',
    'La carte a publié une autre configuration (type, volets ou relais) : cliquez sur « Scanner » dans l’onglet Découverte pour l’accepter. Rien n’a été envoyé.',
  ),
  identityChanged: both(
    'Another MAC address answers for this board: click "Scan" in the Discovery tab to accept it. Nothing sent.',
    'Une autre adresse MAC répond pour cette carte : cliquez sur « Scanner » dans l’onglet Découverte pour l’accepter. Rien n’a été envoyé.',
  ),
  nameShared: both(
    'Several boards use the name of this one: the command would reach all of them. Nothing sent (a stop or a close of a shutter does go).',
    'Plusieurs cartes portent le nom de celle-ci : la commande les atteindrait toutes. Rien n’a été envoyé (l’arrêt et la fermeture d’un volet partent).',
  ),
  tooSlow: both(
    'The command could not leave in time: it was not sent.',
    'La commande n’a pas pu partir à temps : elle n’a pas été envoyée.',
  ),
  sentUnconfirmed: both(
    'Command sent, without confirmation: check the device in a moment.',
    'Commande envoyée, sans confirmation : vérifiez l’appareil dans un instant.',
  ),
};
