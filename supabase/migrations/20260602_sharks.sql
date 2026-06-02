-- Sharks: Polymarket wallets to track positions of.
-- Editable from /sharks page; seeded from src/copy_trader_tracker.py WATCH_LIST.

create table if not exists public.sharks (
  wallet_address  text primary key,
  name            text,
  type            text not null default 'sharp' check (type in ('sharp','fade','watch')),
  emoji           text,
  notes           text,
  added_at        timestamptz not null default now(),
  active          boolean not null default true
);

insert into public.sharks (wallet_address, name) values
  ('0x9c76cdb43fb46454da005fbc82047a64a18ec926', 'Bagwell306'),
  ('0x9a4cf053d6788a095da9be5e811e73131f491f30', 'AmaHnk'),
  ('0x0a6356d95e871f7288063d56a2db518ea004fc03', 'f3arless'),
  ('0xda3a9b7afff7b44ad4fd75308723194e0a11381f', 'Gooooooollllllllll'),
  ('0x85d53efdd055aa88fb00a914f5615bfd585545ee', 'retroactivesource'),
  ('0x40ce68f1564f3c751b12d88a393d8cc0651dbf90', 'JuiceFarm'),
  ('0x3da89a55cdd4b5c69f80e5cd3ef1782a3e0480c3', '(unnamed1)'),
  ('0xdd58b7e8b989f2cd20ccd903ecc4a997ff3618f9', 'texastechbooster'),
  ('0x7a0face7188ae921d0fa1301e237280f73041305', 'Gengfrauds'),
  ('0xd02add54ed7eeeffd39a69b661216346e3dc4771', 'ISKWsouichi'),
  ('0xfc04aa268a487d792cb3580bea0be7eba052f726', 'paperdood'),
  ('0xceed63729dbad7b41afd0140f415684d8967f8ee', 'jdmboy'),
  ('0xf7f0b0b1e9c0fe02ccad926916ee31aef74b912c', 'wapol'),
  ('0xf7c2664cb29240811d6a89dd3960ebbc03a79b8d', 'spartachio')
on conflict (wallet_address) do nothing;
