-- Sincronización de Cuaderno entre dispositivos (aplicado en el proyecto Supabase "Midia").
-- Tablas cerradas (RLS sin políticas, sin permisos para anon): sólo se accede con
-- funciones SECURITY DEFINER que exigen la clave de Cuaderno. En la base se guarda
-- sólo el hash SHA-256 de la clave, nunca la clave.
--
-- Para cambiar la clave:
--   update cuaderno_private.config set key_hash = encode(extensions.digest('NUEVA-CLAVE', 'sha256'), 'hex');

create schema if not exists cuaderno_private;
revoke all on schema cuaderno_private from public, anon, authenticated;

create table cuaderno_private.config (
  id int primary key default 1 check (id = 1),
  key_hash text not null
);

create sequence public.cuaderno_seq;

create table public.cuaderno_docs (
  store text not null,
  id text not null,
  data jsonb,
  mod bigint not null,
  deleted boolean not null default false,
  seq bigint not null default nextval('public.cuaderno_seq'),
  primary key (store, id)
);
create index cuaderno_docs_seq_idx on public.cuaderno_docs (seq);

create table public.cuaderno_blobs (
  id text not null,
  part int not null,
  total int not null,
  mime text,
  data text not null,
  primary key (id, part)
);

alter table public.cuaderno_docs enable row level security;
alter table public.cuaderno_blobs enable row level security;
revoke all on public.cuaderno_docs, public.cuaderno_blobs from anon, authenticated;
revoke all on sequence public.cuaderno_seq from anon, authenticated;

create function cuaderno_private.check_key(k text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if k is null or not exists (
    select 1 from cuaderno_private.config
    where key_hash = encode(extensions.digest(k, 'sha256'), 'hex')
  ) then
    raise exception 'Clave de Cuaderno incorrecta' using errcode = '28000';
  end if;
end $$;
revoke all on function cuaderno_private.check_key(text) from public, anon, authenticated;

-- Sube cambios. Gana el más reciente (mod = milisegundos del dispositivo).
create function public.cuaderno_push(k text, docs jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  perform cuaderno_private.check_key(k);
  insert into public.cuaderno_docs (store, id, data, mod, deleted, seq)
  select d->>'store', d->>'id', d->'data', (d->>'mod')::bigint,
         coalesce((d->>'deleted')::boolean, false), nextval('public.cuaderno_seq')
  from jsonb_array_elements(docs) d
  on conflict (store, id) do update
    set data = excluded.data, mod = excluded.mod, deleted = excluded.deleted, seq = excluded.seq
    where public.cuaderno_docs.mod < excluded.mod;
  return (select coalesce(max(seq), 0) from public.cuaderno_docs);
end $$;

-- Baja lo que cambió desde el último número de secuencia visto.
create function public.cuaderno_pull(k text, since bigint, lim int default 200)
returns table (store text, id text, data jsonb, mod bigint, deleted boolean, seq bigint)
language plpgsql security definer set search_path = '' as $$
begin
  perform cuaderno_private.check_key(k);
  return query
    select d.store, d.id, d.data, d.mod, d.deleted, d.seq
    from public.cuaderno_docs d
    where d.seq > since
    order by d.seq
    limit least(greatest(lim, 1), 1000);
end $$;

-- Archivos propios (grabaciones, fotos, diapositivas) en partes de texto base64.
create function public.cuaderno_blob_put(k text, p_id text, p_part int, p_total int, p_mime text, p_data text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform cuaderno_private.check_key(k);
  insert into public.cuaderno_blobs (id, part, total, mime, data)
  values (p_id, p_part, p_total, p_mime, p_data)
  on conflict (id, part) do update set total = excluded.total, mime = excluded.mime, data = excluded.data;
end $$;

create function public.cuaderno_blob_have(k text, ids text[]) returns setof text
language plpgsql security definer set search_path = '' as $$
begin
  perform cuaderno_private.check_key(k);
  return query
    select b.id from public.cuaderno_blobs b
    where b.id = any(ids)
    group by b.id
    having count(*) = max(b.total);
end $$;

create function public.cuaderno_blob_get(k text, p_id text, p_part int)
returns table (o_total int, o_mime text, o_data text)
language plpgsql security definer set search_path = '' as $$
begin
  perform cuaderno_private.check_key(k);
  return query select b.total, b.mime, b.data from public.cuaderno_blobs b where b.id = p_id and b.part = p_part;
end $$;

revoke all on function public.cuaderno_push(text, jsonb), public.cuaderno_pull(text, bigint, int),
  public.cuaderno_blob_put(text, text, int, int, text, text), public.cuaderno_blob_have(text, text[]),
  public.cuaderno_blob_get(text, text, int) from public;
grant execute on function public.cuaderno_push(text, jsonb), public.cuaderno_pull(text, bigint, int),
  public.cuaderno_blob_put(text, text, int, int, text, text), public.cuaderno_blob_have(text, text[]),
  public.cuaderno_blob_get(text, text, int) to anon, authenticated;

-- La clave se carga aparte (sólo su hash):
-- insert into cuaderno_private.config (id, key_hash) values (1, encode(extensions.digest('CLAVE', 'sha256'), 'hex'));
