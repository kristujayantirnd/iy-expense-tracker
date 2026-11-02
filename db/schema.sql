create table if not exists users (
  id serial primary key,
  email text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists categories (
  id text primary key,
  name text not null,
  budget numeric not null default 0,
  color text not null default '#3b82f6',
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id text primary key,
  name text not null,
  role text not null default '',
  base_salary numeric not null default 0,
  allocations jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id text primary key,
  title text not null,
  category_id text references categories(id) on delete set null,
  type text not null,
  amount numeric not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now()
);

insert into settings (key, value) values ('currency', 'INR') on conflict do nothing;
