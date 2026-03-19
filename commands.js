module.exports = [
  {
    name: 'nm',
    description: 'Start a new match',
    options: [
      {
        name: 'league',
        description: 'League number.',
        type: 'INTEGER',
        required: true,
      },
    ],
  },
  {
    name: 'em',
    description: 'End the current match',
  },
  {
    name: 'dm',
    description: 'Delete the current match.',
  },
  {
    name: 'ns',
    description: 'Start a new seed.',
  },
  {
    name: 'import',
    description: 'Import a match.',
    options: [
      {
        name: 'match_id',
        description: 'Match id.',
        type: 'STRING',
        required: true,
      },
      {
        name: 'seed',
        description: 'Seed number. Leave empty for current seed.',
        type: 'INTEGER',
        required: false,
      },
    ],
  },
  {
    name: 'reg',
    description: 'Register yourself for the competition.',
  },
  {
    name: 'admin_reg',
    description: 'Register a player for the competition.',
    options: [
      {
        name: 'user',
        description: 'Player to register.',
        type: 'USER',
        required: true,
      },
      {
        name: 'ign',
        description: 'Their username.',
        type: 'STRING',
        required: true,
      },
    ],
  },
  {
    name: 'unreg',
    description: 'Unregister yourself from the competition.',
  },
  {
    name: 'remove',
    description: 'Remove a player from the competition.',
    options: [
      {
        name: 'user',
        description: 'Player to remove.',
        type: 'USER',
        required: true,
      },
    ],
  },
  {
    name: 'toggle_registration',
    description: 'Enable or disable player registration for this match.',
    options: [
      {
        name: 'enabled',
        description: 'Whether player registration is open.',
        type: 'BOOLEAN',
        required: true,
      },
    ],
  },
  {
    name: 'toggle_logs',
    description: 'Enable or disable command logging.',
    options: [
      {
        name: 'enabled',
        description: 'Whether command usage logging is enabled.',
        type: 'BOOLEAN',
        required: true,
      },
    ],
  },
  {
    name: 'adjust',
    description: 'Adjust any player point total.',
    options: [
      {
        name: 'points',
        description: 'Add or subtract points.',
        type: 'INTEGER',
        required: true,
      },
      {
        name: 'user',
        description: 'Target user.',
        type: 'USER',
        required: true,
      },
    ],
  },
  {
    name: 'promote',
    description: 'Set how many players should be promoted for this match.',
    options: [
      {
        name: 'count',
        description: 'Number of players to promote.',
        type: 'INTEGER',
        required: true,
      },
    ],
  },
  {
    name: 'demote',
    description: 'Set how many players should be demoted for this match.',
    options: [
      {
        name: 'count',
        description: 'Number of players to demote.',
        type: 'INTEGER',
        required: true,
      },
    ],
  },
  {
    name: 'relegate',
    description: 'Apply the promotion and demotion results.',
  },
  {
    name: 'clear',
    description: 'Clear all standings for one seed.',
    options: [
      {
        name: 'seed',
        description: 'Seed number.',
        type: 'INTEGER',
        required: false,
      },
    ],
  },
  {
    name: 'r',
    description: 'Reset one player result in a seed.',
    options: [
      {
        name: 'user',
        description: 'Player to reset. Leave empty to reset yourself.',
        type: 'USER',
        required: false,
      },
      {
        name: 'seed',
        description: 'Seed number.',
        type: 'INTEGER',
        required: false,
      },
    ],
  },
  {
    name: 'edit',
    description: 'Edit one player result for one specific seed.',
    options: [
      {
        name: 'user',
        description: 'Player to edit.',
        type: 'USER',
        required: true,
      },
      {
        name: 'seed',
        description: 'Seed number.',
        type: 'INTEGER',
        required: false,
      },
      {
        name: 'time',
        description: 'New time in mm:ss.mmm. Leave empty only if marking as DNF.',
        type: 'STRING',
        required: false,
      },
      {
        name: 'dnf',
        description: 'Mark true if the player did not finish.',
        type: 'BOOLEAN',
        required: false,
      },
    ],
  },
  {
    name: 'l',
    description: 'Show the current competition leaderboard for your league.',
  },
  {
    name: 'stats',
    description: 'Show points summary and seed placements for a player in the current competition.',
    options: [
      {
        name: 'user',
        description: 'Player to inspect. Defaults to you.',
        type: 'USER',
        required: false,
      },
    ],
  },
  {
    name: 's',
    description: 'Show standings for the seed.',
    options: [
      {
        name: 'seed',
        description: 'Seed number.',
        type: 'INTEGER',
        required: false,
      },
    ],
  },
  {
    name: 'help',
    description: 'Links the list of commands for this bot as well as extra information.',
  },
];
