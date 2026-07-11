-- ============================================================
-- ¿Qué comer? — configuración de la base de datos en Supabase
-- Va en el MISMO proyecto que Outfit Hoy (wtqbhrctsnyodofwquuc):
-- tabla y bucket nuevos, los usuarios se comparten.
-- Cómo usarlo: SQL Editor → New query → pegar TODO → Run.
-- Solo hay que hacerlo una vez.
-- ============================================================

-- Tabla de comidas (una fila por comida; la foto va en Storage).
-- Mismo esquema que `outfits` + nombre/lugar propios de comidas.
-- photo_ver = 0 significa "esta comida no tiene foto".
create table if not exists public.comidas (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nombre text not null default '',
  lugar text not null default '',
  tipos text[] not null default '{}',
  distritos text[] not null default '{}',
  notas text not null default '',
  favorito boolean not null default false,
  usos text[] not null default '{}',
  extras text[] not null default '{}',
  photo_ver integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seguridad: cada usuaria solo ve y toca sus propias filas
alter table public.comidas enable row level security;

drop policy if exists "comidas_propias" on public.comidas;
create policy "comidas_propias" on public.comidas
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Perfil de comidas de cada usuario (sus distritos personalizados)
create table if not exists public.perfiles_comida (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  distritos text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.perfiles_comida enable row level security;

drop policy if exists "perfil_comida_propio" on public.perfiles_comida;
create policy "perfil_comida_propio" on public.perfiles_comida
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Bucket PRIVADO para las fotos de comida (cada usuaria en su carpeta)
insert into storage.buckets (id, name, public)
  values ('fotos-comida', 'fotos-comida', false)
  on conflict (id) do nothing;

drop policy if exists "fotos_comida_select" on storage.objects;
create policy "fotos_comida_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'fotos-comida' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "fotos_comida_insert" on storage.objects;
create policy "fotos_comida_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fotos-comida' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "fotos_comida_update" on storage.objects;
create policy "fotos_comida_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'fotos-comida' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'fotos-comida' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "fotos_comida_delete" on storage.objects;
create policy "fotos_comida_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'fotos-comida' and (storage.foldername(name))[1] = auth.uid()::text);
