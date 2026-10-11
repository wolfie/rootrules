// Common names players use for factions, to help search map "cats" to the Marquise etc.
// Keyed by the upstream faction icon key (`icon: faction-<key>` in rules.yml).
// The full faction name is always added as an alias automatically.
export const FACTION_ALIASES: Record<string, string[]> = {
  marquise: ['cats', 'marquise', 'mdc'],
  eyrie: ['birds', 'eyrie'],
  woodland: ['alliance', 'wa'],
  vagabond: ['vagabond', 'vb'],
  cult: ['lizards', 'cult'],
  riverfolk: ['otters', 'riverfolk'],
  duchy: ['moles', 'duchy'],
  corvid: ['crows', 'corvids'],
  warlord: ['rats', 'hundreds', 'warlord'],
  keepers: ['badgers', 'keepers'],
  diaspora: ['frogs', 'lilypad', 'diaspora'],
  council: ['council', 'twilight'],
  knaves: ['skunks', 'knaves', 'deepwood'],
};
