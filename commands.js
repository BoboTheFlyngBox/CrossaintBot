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
      {
        name: 'week',
        description: 'Week number.',
        type: 'INTEGER',
        required: true,
      },
    ],
  },
  {
    name: 'championship',
    description: 'Start a league championship.',
    options: [
      {
        name: 'league',
        description: 'Championship league number.',
        type: 'INTEGER',
        required: true,
        choices: [
          { name: 'League 2', value: 2 },
          { name: 'League 3', value: 3 },
          { name: 'League 4', value: 4 },
          { name: 'League 5', value: 5 },
          { name: 'League 6', value: 6 },
        ],
      },
    ],
  },
  {
    name: 'em',
    description: 'End the current match',
  },
  {
    name: 'unend',
    description: 'Undo ending the current match.',
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
    name: 'remove_seed',
    description: 'Remove the latest championship seed.',
  },
  {
    name: 'import',
    description: 'Import a match.',
    options: [
      {
        name: 'match_id',
        description: 'Match id.',
        type: 'STRING',
        required: false,
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
    name: 'forceinput',
    description: 'Import a match and automatically register every player.',
    options: [
      {
        name: 'match_id',
        description: 'Match id.',
        type: 'STRING',
        required: true,
      },
      {
        name: 'seed_number',
        description: 'Seed number.',
        type: 'INTEGER',
        required: true,
      },
    ],
  },
  {
    name: 'refresh',
    description: 'Refresh all seeds.',
  },
  {
    name: 'host',
    description: 'Become the host for this competition.',
  },
  {
    name: 'reg',
    description: 'Register yourself for the competition.',
    options: [
      {
        name: 'twitch',
        description: 'Optional Twitch username.',
        type: 'STRING',
        required: false,
      },
    ],
  },
  {
    name: 'signup',
    description: 'Request to signup.',
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
        name: 'mc_username',
        description: 'Optional MCSR username.',
        type: 'STRING',
        required: false,
      },
      {
        name: 'twitch',
        description: 'Optional Twitch username.',
        type: 'STRING',
        required: false,
      },
    ],
  },
  {
    name: 'unreg',
    description: 'Unregister yourself.',
  },
  {
    name: 'remove',
    description: 'Remove a player.',
    options: [
      {
        name: 'user',
        description: 'Player.',
        type: 'USER',
        required: true,
      },
    ],
  },
  {
    name: 'toggle_registration',
    description: 'Enable or disable player registration.',
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
    name: 'toggle_report',
    description: 'Enable or disable player score reports for this match.',
    options: [
      {
        name: 'enabled',
        description: 'Whether players can submit score reports.',
        type: 'BOOLEAN',
        required: true,
      },
    ],
  },
  {
    name: 'report_score',
    description: 'Report a best-of-three score against another player.',
    options: [
      {
        name: 'opponent',
        description: 'The player you played against.',
        type: 'USER',
        required: true,
      },
      {
        name: 'score',
        description: 'The score from your perspective.',
        type: 'STRING',
        required: true,
        choices: [
          { name: '2-0', value: '2-0' },
          { name: '2-1', value: '2-1' },
          { name: '0-2', value: '0-2' },
          { name: '1-2', value: '1-2' },
        ],
      },
    ],
  },
  {
    name: 'admin_report_score',
    description: 'Submit any best-of-three score for reviewer approval.',
    options: [
      {
        name: 'winner',
        description: 'The winning player.',
        type: 'USER',
        required: true,
      },
      {
        name: 'loser',
        description: 'The losing player.',
        type: 'USER',
        required: true,
      },
      {
        name: 'score',
        description: 'The winning score.',
        type: 'STRING',
        required: true,
        choices: [
          { name: '2-0', value: '2-0' },
          { name: '2-1', value: '2-1' },
        ],
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
    name: 'fill',
    description: 'Fill the player database from current league roles.',
  },
  {
    name: 'test',
    description: 'Enable or disable test mode for this match.',
    options: [
      {
        name: 'enabled',
        description: 'Whether test mode is enabled.',
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
    name: 'p',
    description: 'Promote one player by one league.',
    options: [
      {
        name: 'user',
        description: 'Player to promote.',
        type: 'USER',
        required: true,
      },
    ],
  },
  {
    name: 'd',
    description: 'Demote one player by one league.',
    options: [
      {
        name: 'user',
        description: 'Player to demote.',
        type: 'USER',
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
    name: 'lb',
    description: 'Show the current competition leaderboard of a certain league.',
    options: [
      {
        name: 'league',
        description: 'League to view the leaderboard of. Defaults to your league.',
        type: 'INTEGER',
        required: false,
      },
    ],
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
    name: 'zscores',
    description: 'Show the top z-scores for a league.',
    options: [
      {
        name: 'league',
        description: 'League to view. Defaults to your league.',
        type: 'INTEGER',
        required: false,
      },
    ],
  },
  {
    name: 'zreset',
    description: 'Reset all saved z-scores.',
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
    name: 'link',
    description: 'Shows the user how to connect their Discord and Ranked accounts',
  },
  {
    name: 'help',
    description: 'Links the list of commands for this bot as well as extra information.',
  },
  {
    name: 'players',
    description: 'Show registered players in peak Elo order.',
  },
  {
    name: 'list',
    description: 'Export the current registration list as a .ranked file.',
  },
];
