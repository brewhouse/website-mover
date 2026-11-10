import { frameworkIndex, type TargetSchema } from '../src/index.js';

/** Three mockup pages sharing a shell, a target schema and a framework index, for the model and plan tests. */
const shell = (main: string) => `<html><body>
  <a class="skip_link" href="#main">Skip to content</a>
  <header class="main_header"><a href="index.html">City Portal</a><input placeholder="Search"></header>
  <div class="main_wrapper"><div class="page_layout">
    <aside class="page_sidebar"><nav class="side_nav"><ul>
      <li><a href="index.html">Dashboard</a></li>
      <li><a href="#">Departments</a><ul><li><a href="dept.html">Finance</a></li><li><a href="dept.html">Police</a></li></ul></li>
      <li><a href="news.html">News</a></li>
    </ul></nav></aside>
    <div class="page_main">${main}</div>
  </div></div>
  <footer class="main_footer"><nav class="footer_nav"><ul><li><a href="#">Privacy</a></li><li><a href="#">Contact HR</a></li></ul></nav></footer>
</body></html>`;

const intro = (title: string) => `<div class="page_intro"><div class="page_heading"><h1>${title}</h1></div><div class="main_breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="index.html">Dashboard</a></li><li class="breadcrumb-item">${title}</li></ol></div></div>`;
const card = (n: number) => `<div class="col-md-4 news_col"><a href="post${n}.html"><img src="img/p${n}.jpg" alt="Photo ${n}"><span class="category">Category</span><h3>Card Title ${n}</h3><p class="date">June 22, 2026</p></a></div>`;

export const pages = [
  {
    file: 'dept.html',
    frames: ['1:1'],
    html: shell(`<div class="page_intro"><div class="page_heading"><h1>Department Name</h1></div>
      <div class="detail_wrap"><div class="row"><div class="col-md-9">
        <div class="overview_info"><h2>Overview</h2><p>Lorem ipsum with a <a href="#">link</a> in it.</p></div>
        <section class="staff"><div class="topTitle"><h2>Staff</h2></div><div class="staff_list">
          ${[1, 2, 3].map(() => `<article class="staff_card"><span class="staff_initials">EN</span><div class="staff_card__name"><h3>Employee Name</h3><p>Manager</p></div><p class="staff_card__contact"><a href="mailto:e@city.gov">e@city.gov</a></p></article>`).join('')}
        </div></section>
      </div></div></div></div>`),
  },
  {
    file: 'news.html',
    frames: [],
    html: shell(`${intro('News')}
      <div class="listing_filter"><ul class="filter_tags"><li><a href="#">All</a></li><li><a href="#">HR</a></li><li><a href="#">IT</a></li></ul></div>
      <section class="news_cards"><div class="topTitle"><h2>Department News</h2><a class="text_link" href="#">View All <img src="img/arrow.svg"></a></div><div class="row">${[1, 2, 3].map(card).join('')}</div></section>
      <nav class="listing_pagination"><ul><li><a href="#">1</a></li><li><a href="#">2</a></li></ul></nav>`),
  },
  {
    file: 'result.html',
    frames: [],
    html: shell(`${intro('Search')}${[1, 2, 3, 4].map((n) => `<div class="result_row"><h3><a href="r${n}.html">Result ${n}</a></h3><p>Snippet ${n}</p></div>`).join('')}`),
  },
];

export const schema: TargetSchema = {
  post_types: {
    post: { label: 'Posts', rest_base: 'posts', has_archive: false, rewrite: false, hierarchical: false, taxonomies: ['category'] },
    page: { label: 'Pages', rest_base: 'pages', has_archive: false, rewrite: false, hierarchical: true, taxonomies: [] },
    departments: { label: 'Departments', rest_base: 'departments', has_archive: true, rewrite: 'departments', hierarchical: false, taxonomies: [] },
    people: { label: 'People', rest_base: 'people', has_archive: false, rewrite: 'people', hierarchical: false, taxonomies: [] },
  },
  taxonomies: {},
  acf: null,
};

export const framework = frameworkIndex('/theme', [
  { file: 'template-parts/blocks/staff.php', classes: ['staff', 'staff_list', 'staff_card', 'staff_initials', 'topTitle'], block: 'staff_block' },
  { file: 'page.php', classes: ['page_intro', 'page_heading', 'main_breadcrumb', 'breadcrumb'], block: null },
]);

