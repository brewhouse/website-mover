/** The target's content schema as the bridge reports it (GET /website-mover/v1/schema). */
export interface AcfField {
  key: string;
  name: string;
  label: string;
  type: string;
  sub_fields?: AcfField[];
  layouts?: { name: string; label: string; sub_fields: AcfField[] }[];
  [k: string]: unknown;
}

export interface AcfFieldGroup {
  key: string;
  title: string;
  location: { param: string; operator: string; value: string }[][];
  fields: AcfField[];
  active?: boolean;
  [k: string]: unknown;
}

export interface TargetSchema {
  post_types: Record<string, { label: string; rest_base: string; has_archive: boolean | string; rewrite: string | false; hierarchical: boolean; taxonomies: string[] }>;
  taxonomies: Record<string, { label: string; object_type: string[]; rest_base: string; hierarchical: boolean }>;
  acf: {
    post_types: { key: string; post_type: string; title: string; [k: string]: unknown }[];
    taxonomies: { key: string; taxonomy: string; title: string; [k: string]: unknown }[];
    field_groups: AcfFieldGroup[];
  } | null;
}

/** Field groups shown on a post type, page template or block (by ACF location rules). */
export function groupsFor(schema: TargetSchema, match: { param: string; value: string }): AcfFieldGroup[] {
  return (schema.acf?.field_groups ?? []).filter((g) => g.location.some((and) => and.some((r) => r.param === match.param && r.operator === '==' && r.value === match.value)));
}

/** A compact view for people and the model: "group title: field (type), field (type)…". */
export function describeGroups(groups: AcfFieldGroup[]): string[] {
  const f = (x: AcfField): string => `${x.name} (${x.type}${x.sub_fields?.length ? `: ${x.sub_fields.map(f).join(', ')}` : ''})`;
  return groups.map((g) => `${g.title} [${g.key}]: ${g.fields.filter((x) => x.type !== 'tab').map(f).join(', ')}`);
}
