-- Sharks: Polymarket wallets to track positions of.
-- Editable from /sharks page; seeded with the existing PolymarketFollow list.

create table if not exists public.sharks (
  wallet_address  text primary key,
  name            text,
  type            text not null default 'sharp' check (type in ('sharp','fade','watch')),
  emoji           text,
  notes           text,
  added_at        timestamptz not null default now(),
  active          boolean not null default true
);

insert into public.sharks (wallet_address, name, type, emoji, notes) values
  ('0x76cf0286fa25599a491ea4980abee915eece9452', 'fuc.your.mother', 'sharp', '🎯', null),
  ('0x1136368d7f6728e94ed14c532ab95a932f710c2e', 'arlanta',         'sharp', '🎯', null),
  ('0xa5ea13a81d2b7e8e424b182bdc1db08e756bd96a', 'bossoskill',      'sharp', '🐳', '$270k vol, top LoL trader'),
  ('0x9b491485819135564450669aeadb2d85f7b104a8', 'htfjyf',          'sharp', '🦈', '71% WR, $299k vol'),
  ('0xd4081f280de71b3e82b15bdc724588556f52e85c', 'Zetalias',        'sharp', '🦈', '100% WR, $120k vol'),
  ('0xcae693bcf9696a2ebf0a62de767719b45f354f85', 'geiyecapixie',    'sharp', '🦈', '91% WR, $148k vol'),
  ('0x66e530fb5dfee92bb9be9b7519d2dcc8a84dd3c7', 'zywoo2026',       'sharp', '🦈', '81% WR, $41k vol'),
  ('0x40ea0091a07c69dd83a3a1fa70b8b29e2e1f832f', 'wupplasaurus',    'fade',  '🔻', 'fade — bet opposite')
on conflict (wallet_address) do nothing;
