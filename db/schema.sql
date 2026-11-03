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

-- Payouts: roles, salary and profile on each login. Existing logins become admins.
alter table users add column if not exists role text;
update users set role = 'admin' where role is null;
alter table users alter column role set default 'employee';
alter table users alter column role set not null;
alter table users add column if not exists salary numeric not null default 0;
alter table users add column if not exists profile jsonb not null default '{}';
alter table users add column if not exists name text not null default '';

-- employer/employee hold a copy of the details at the time of the last edit, so approved invoices never change.
create table if not exists invoices (
  id serial primary key,
  user_id int not null references users(id),
  kind text not null check (kind in ('salary', 'reimbursement')),
  number int not null,
  invoice_date date not null,
  items jsonb not null,
  total numeric not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note text not null default '',
  employer jsonb not null default '{}',
  employee jsonb not null default '{}',
  decided_by int references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, number)
);


-- Scanned bills uploaded for reimbursement rows (files live in Vercel Blob). deleted_at = cleared from storage.
create table if not exists bills (
  id serial primary key,
  user_id int not null references users(id),
  pathname text not null,
  size int not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- After approval: payment progress ('' | submitted | paid) and the copy saved to Google Drive.
alter table invoices add column if not exists payment_status text not null default '';
alter table invoices add column if not exists drive_url text not null default '';
alter table invoices add column if not exists drive_error text not null default '';

-- Optional direct-expense category for reimbursements, and admin can cancel approved invoices.
alter table invoices add column if not exists category_id text references categories(id) on delete set null;
-- Categories are now per row: copy any invoice-level category onto rows without one, then clear it.
update invoices set items = (select jsonb_agg(case when it ? 'categoryId' then it else it || jsonb_build_object('categoryId', invoices.category_id) end)
                             from jsonb_array_elements(items) it),
                    category_id = null
  where category_id is not null;
alter table invoices drop constraint if exists invoices_status_check;
alter table invoices add constraint invoices_status_check check (status in ('pending', 'approved', 'rejected', 'cancelled'));
-- A cancelled salary invoice frees its month for a new one.
drop index if exists one_salary_invoice_per_month;
create unique index one_salary_invoice_per_month
  on invoices (user_id, extract(year from invoice_date), extract(month from invoice_date)) where kind = 'salary' and status <> 'cancelled'
