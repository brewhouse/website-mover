import type { JobOptions } from '@wm/db';

/** The job options as checkboxes (new-job form and the job page). Each plan records the options it was made with. */
export const OPTION_FIELDS: { name: keyof JobOptions; label: string; hint: string }[] = [
  {
    name: 'incremental',
    label: 'Only new content (incremental)',
    hint: 'Migrates only what isn’t on the target yet: pages, posts, events, files and entries added on the source since the earlier migration. Content already on the target is left exactly as it is (changes to it on the source aren’t copied), and nothing on the target is trashed.',
  },
  {
    name: 'contentOnly',
    label: 'Content only (no templates, menus or design)',
    hint: 'Migrates content only: pages, posts, events, people, files, forms and redirects. Menus, theme options, homepage fields, logos, fonts and CSS, and site settings are left as they are on the target.',
  },
  {
    name: 'sideNavMenu',
    label: 'Add the side navigation to the main menu',
    hint: 'The source’s left-hand section menus become dropdowns under the matching main menu items (up to three levels). A page appears once in the menu. Has no effect with “Content only”.',
  },
];

export function OptionFields({ values }: { values: Partial<Record<keyof JobOptions, boolean | string>> }) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-medium">Options</legend>
      {OPTION_FIELDS.map((o) => (
        <label key={o.name} className="flex items-start gap-2 text-sm">
          <input type="checkbox" name={o.name} defaultChecked={values[o.name] === true || values[o.name] === 'on'} className="mt-0.5" />
          <span>
            {o.label}
            <span className="block text-xs text-muted">{o.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The options a form submitted. */
export function optionsFrom(form: FormData): JobOptions {
  return { incremental: form.get('incremental') === 'on', contentOnly: form.get('contentOnly') === 'on', sideNavMenu: form.get('sideNavMenu') === 'on' };
}
