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
-- Extra roles on top of the main role, each widening access to one module (e.g. 'pt_admin' = Project Tracker admin).
alter table users add column if not exists extra_roles text[] not null default '{}';

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
  on invoices (user_id, extract(year from invoice_date), extract(month from invoice_date)) where kind = 'salary' and status <> 'cancelled';

-- Reimbursements collect on one open invoice per employee and are numbered on approval.
alter table invoices alter column number drop not null;
update invoices set items = (select jsonb_agg(case when it ? 'date' then it else it || jsonb_build_object('date', to_char(invoices.invoice_date, 'YYYY-MM-DD')) end)
                             from jsonb_array_elements(items) it)
  where kind = 'reimbursement' and exists (select 1 from jsonb_array_elements(items) it where not it ? 'date');
create unique index if not exists one_open_reimbursement on invoices (user_id) where kind = 'reimbursement' and status in ('pending', 'rejected');

-- Inactive logins cannot sign in or use the app.
alter table users add column if not exists active boolean not null default true;

-- Salary revisions (hikes). old_salary is null for the starting salary.
create table if not exists salary_revisions (
  id serial primary key,
  user_id int not null references users(id),
  old_salary numeric,
  new_salary numeric not null,
  effective_date date not null,
  note text not null default '',
  created_by int references users(id),
  created_at timestamptz not null default now()
);
-- Starting record for logins that have a salary but no history yet.
insert into salary_revisions (user_id, old_salary, new_salary, effective_date, note)
  select id, null, salary, (created_at at time zone 'Asia/Kolkata')::date, 'Starting salary'
  from users u where salary > 0 and not exists (select 1 from salary_revisions r where r.user_id = u.id);

-- Project Tracker owner linked to each login (single sign-on sends linked employees to their owner page).
create table if not exists pt_owner_links (
  owner_id text primary key,
  owner_name text not null default '',
  user_id int not null unique references users(id) on delete cascade
);

-- Direct-expense reimbursements (raised by the admin from the Expense Tracker's direct expenses):
-- no employee, not in the payout register, one open company-wide invoice at a time.
alter table invoices add column if not exists direct boolean not null default false;
drop index if exists one_open_reimbursement;
create unique index one_open_reimbursement on invoices (user_id) where kind = 'reimbursement' and status in ('pending', 'rejected') and not direct;
create unique index if not exists one_open_direct on invoices (direct) where direct and kind = 'reimbursement' and status in ('pending', 'rejected');

-- Client Invoice Automator: the client address book (settings live in settings.invoiceConfig).
-- The sheet's invoice rows refer to clients by name, so a name is never changed once created.
create table if not exists clients (
  id serial primary key,
  name text not null,
  emails text not null,
  contact text not null default '',
  on_hold boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists clients_name_key on clients (lower(name));

-- Client Invoice Automator: reimbursement invoice requests being put together row by row, one open per client.
-- Sent to the sheet (and deleted here) when submitted to the Finance Team.
create table if not exists reimb_requests (
  id serial primary key,
  client text not null,
  invoice_type text not null,
  po_number text not null default '',
  items jsonb not null default '[]',
  updated_by int references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists reimb_requests_client_key on reimb_requests (lower(client));

-- Receivables · Products & Services master: each product/service has a list of items, each tagged with
-- a pricing model, whether it is mandatory, and the other items it needs first (prerequisites, item ids).
create table if not exists ps_products (
  id serial primary key,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists ps_products_name_key on ps_products (lower(name));
create table if not exists ps_items (
  id serial primary key,
  product_id int not null references ps_products(id) on delete cascade,
  name text not null,
  pricing_model text not null check (pricing_model in ('per_head', 'per_batch', 'per_hour', 'per_day', 'per_month', 'fixed')),
  mandatory boolean not null default false,
  prerequisites int[] not null default '{}',
  sort int not null default 0
);
create index if not exists ps_items_product on ps_items (product_id);

-- Rate cards: products added row by row, their items carried in with a charge (unit price) each.
-- The item's attributes are copied in and may be changed for this rate card.
create table if not exists rate_cards (
  id serial primary key,
  name text not null,
  description text not null default '',
  updated_at timestamptz not null default now()
);
create unique index if not exists rate_cards_name_key on rate_cards (lower(name));
create table if not exists rate_card_items (
  id serial primary key,
  rate_card_id int not null references rate_cards(id) on delete cascade,
  item_id int not null references ps_items(id),
  unit_price numeric not null default 0,
  pricing_model text not null,
  mandatory boolean not null default false,
  prerequisites int[] not null default '{}',
  sort int not null default 0,
  unique (rate_card_id, item_id)
);

-- Client engagement plans: a rate card copied to a client, then shaped into the client's cost structure.
-- units = head count / batches / hours / days / months (1 for fixed); actual = unit_price * units;
-- signed_up null = same as actual. Once frozen, the signed-up total must stay at frozen_total.
create table if not exists client_plans (
  id serial primary key,
  client_id int not null references clients(id),
  name text not null,
  rate_card_id int references rate_cards(id) on delete set null,
  notes text not null default '',
  frozen_total numeric,
  frozen_at timestamptz,
  frozen_by int references users(id) on delete set null,
  updated_by int references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists client_plan_items (
  id serial primary key,
  plan_id int not null references client_plans(id) on delete cascade,
  item_id int not null references ps_items(id),
  pricing_model text not null,
  mandatory boolean not null default false,
  prerequisites int[] not null default '{}',
  unit_price numeric not null default 0,
  units numeric not null default 1,
  signed_up numeric,
  sort int not null default 0,
  unique (plan_id, item_id)
);

-- Products & Services: notes and (optional) employees per list item; Per Head-Monthly pricing
-- (a plan row then takes a head count and a number of months: actual = unit price x heads x months).
alter table ps_items add column if not exists notes text not null default '';
alter table ps_items add column if not exists employee_ids int[] not null default '{}';
alter table ps_items drop constraint if exists ps_items_pricing_model_check;
alter table ps_items add constraint ps_items_pricing_model_check
  check (pricing_model in ('per_head', 'per_head_month', 'per_batch', 'per_hour', 'per_day', 'per_month', 'fixed'));
alter table client_plan_items add column if not exists months numeric;
alter table client_plan_items add column if not exists notes text not null default '';
-- Engagement plans are listed in the order they are dragged to.
alter table client_plans add column if not exists sort int not null default 0;

-- Receivables in the database (were the sheet's RequestInvoice and Invoice Extracts tabs). The sheet keeps those two
-- tabs only as the mailing queue for its Apps Script; each sheet row carries the record's id in an AppId column.
-- settings.receivablesSource = 'db' once the sheet has been imported (until then the app reads the sheet).
create table if not exists invoice_requests (
  id serial primary key,
  invoice_type text not null,
  client text not null,
  category text not null default '',
  invoice_date date,
  description text not null default '',
  po_number text not null default 'N/A',
  amount numeric not null default 0,
  email_status text not null default 'TO SEND',
  attachments text not null default '',
  extra jsonb not null default '{}',
  sheet_error text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists receivable_invoices (
  id serial primary key,
  client text not null,
  invoice_number text not null default '',
  invoice_date date,
  category text not null default '',
  amount numeric not null default 0,
  with_gst numeric,
  to_receive numeric,
  due_date date,
  pdf_url text not null default '',
  status text not null default 'NEW_ENTRY',
  email_thread text not null default '',
  invoice_type text not null default '',
  received_date date,
  bills text not null default '',
  pdf_without_bills text not null default '',
  pdf_with_bills text not null default '',
  extra jsonb not null default '{}',
  draft jsonb,
  request_id int references invoice_requests(id) on delete set null,
  sheet_error text not null default '',
  updated_by int references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Revenue Planner: a frozen engagement plan's invoice schedule (the signed-up total split into dated invoices).
-- "Generate invoices" turns each row into a Finance Team request + a NEW_ENTRY invoice (invoice_id). Each generated
-- invoice is accounted to the plan's list items in proportion to their signed-up amounts (invoice_allocations), which
-- feeds the product / service and employee revenue views.
create table if not exists plan_invoices (
  id serial primary key,
  plan_id int not null references client_plans(id) on delete cascade,
  seq int not null,
  amount numeric not null,
  invoice_date date not null,
  invoice_id int references receivable_invoices(id) on delete set null,
  unique (plan_id, seq)
);
create table if not exists invoice_allocations (
  invoice_id int not null references receivable_invoices(id) on delete cascade,
  plan_id int references client_plans(id) on delete set null,
  item_id int not null references ps_items(id),
  amount numeric not null,
  primary key (invoice_id, item_id)
);

-- Invoice schedule rows carry the request's details: particulars, due date and an optional PO number.
alter table plan_invoices add column if not exists particulars text not null default '';
alter table plan_invoices add column if not exists due_date date;
alter table plan_invoices add column if not exists po_number text not null default '';

-- Revenue split between the employees mapped to a list item ({ "<user id>": percent }, adding up to 100; empty = equal shares).
alter table ps_items add column if not exists employee_split jsonb not null default '{}';

-- A plan row may set its own employees and revenue split (null = follow the list item's in Products & Services).
alter table client_plan_items add column if not exists employee_ids int[];
alter table client_plan_items add column if not exists employee_split jsonb;

-- Email trail for Manage Invoices: when the last client email / reminder went out, and when the Finance Team request was emailed.
alter table receivable_invoices add column if not exists last_email_at timestamptz;
alter table receivable_invoices add column if not exists last_email_kind text not null default '';
alter table receivable_invoices add column if not exists reminders_sent int;
alter table invoice_requests add column if not exists sent_at timestamptz;
