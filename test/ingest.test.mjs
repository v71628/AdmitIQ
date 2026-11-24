// Fixtures are trimmed copies of real rows returned by the Urban Institute Education Data Portal
// (IPEDS) and the BLS OOH XML compilation, retrieved 2026-11-24.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../scripts/ingest/transform.mjs';

const harvardDir = { unitid: 166027, inst_name: 'Harvard University', state_abbr: 'MA', zip: '02138', city: 'Cambridge', county_name: 'Middlesex County', inst_control: 2, institution_level: 4, sector: 2, hbcu: 0, tribal_college: 0, medical_degree: 1, land_grant: 0, urban_centric_locale: 12, offering_highest_degree: 11, currently_active_ipeds: 1, title_iv_indicator: 1, url_school: 'www.harvard.edu/', degree_granting: 1, inst_size: 5, inst_alias: ' ', url_fin_aid: 'college.harvard.edu/financial-aid', url_application: 'college.harvard.edu/admissions/apply/application-requirements', url_netprice: 'college.harvard.edu/financial-aid/net-price-calculator', url_veterans: 'sfs.harvard.edu/veteran-military-benefits', url_athletes: 'https://gocrimson.com/sports/2023/8/11/student-athlete-graduation-rates.aspx', url_disability_services: 'accessibility.harvard.edu/', longitude: -71.118313, latitude: 42.374471, cc_basic_2021: 15, region: 1 };

test('normalizeUrl de-duplicates harmless variations but keeps paths case-sensitive', () => {
  assert.equal(T.normalizeUrl('www.Harvard.edu/'), 'https://harvard.edu');
  assert.equal(T.normalizeUrl('http://harvard.edu:80/#top'), 'https://harvard.edu');
  assert.equal(T.normalizeUrl('https://x.edu/Admissions/Apply'), 'https://x.edu/Admissions/Apply');
  assert.equal(T.normalizeUrl('https://collegescorecard.ed.gov/school/?166027'), 'https://collegescorecard.ed.gov/school/?166027');
  for (const bad of ['-2', ' ', '', null, 'N/A', 'localhost', 'not a url']) assert.equal(T.normalizeUrl(bad), null, String(bad));
});

test('directory row → college row (no invented values)', () => {
  const c = T.directoryToCollege(harvardDir, 2024);
  assert.equal(c.id, '166027');
  assert.equal(c.control, 'Private nonprofit');
  assert.equal(c.level, 'Four-year');
  assert.equal(c.setting, 'Urban');
  assert.equal(c.website, 'https://www.harvard.edu/');
  assert.equal(c.alias, null);
  assert.equal(c.medical_degree, true);
  assert.equal(T.directoryToCollege(harvardDir, 2024, 'harvard').id, 'harvard', 'existing ids are kept');
  const cc = T.directoryToCollege({ ...harvardDir, inst_control: 1, institution_level: 2, cc_basic_2021: -2, latitude: null }, 2024);
  assert.equal(cc.kind, 'Community college');
  assert.equal(cc.carnegie_basic, null);
  assert.equal(cc.lat, null);
});

test('directory row → 9 distinct official sources', () => {
  const s = T.directoryToSources(harvardDir, 2024);
  assert.equal(s.length, 9);
  assert.ok(s.every((x) => x.reliability_tier === 1 && x.url_normalized && x.college_id === '166027'));
  assert.deepEqual(s.map((x) => x.category).sort(), ['accessibility', 'admissions_statistics', 'affordability', 'affordability', 'athletics', 'college_admissions', 'financial_aid', 'institution_home', 'veterans']);
  assert.equal(new Set(s.map((x) => x.url_normalized)).size, 9);
  const inactive = T.directoryToSources({ ...harvardDir, currently_active_ipeds: 0, url_veterans: '-2', url_athletes: null }, 2024);
  assert.equal(inactive.length, 5, 'no federal profile pages for closed institutions, missing URLs skipped');
});

test('dedupe removes duplicate and invalid records', () => {
  const a = T.directoryToSources(harvardDir, 2024);
  const { sources, dupes, invalid } = T.dedupeSources([...a, ...a, { title: 'x', url_normalized: null }]);
  assert.equal(sources.length, 9); assert.equal(dupes, 9); assert.equal(invalid, 1);
});

test('statistics transforms use the right IPEDS codes', () => {
  const idFor = (u) => String(u);
  const adm = T.admissionsStats([{ unitid: 166027, sex: 3, number_applied: -1, number_admitted: -1, number_enrolled_total: -1 }, { unitid: 166027, sex: 99, number_applied: 54008, number_admitted: 1970, number_enrolled_total: 1647 }], 2024, idFor);
  assert.equal(adm.find((x) => x.field === 'admit_rate').value_num, 0.0365);
  assert.equal(adm.find((x) => x.field === 'yield_rate').value_num, 0.836);
  assert.equal(adm.length, 5);
  const req = T.requirementsStats([{ unitid: 166027, reqt_test_scores: 3, sat_crit_read_25_pctl: 730, sat_crit_read_75_pctl: 780, sat_math_25_pctl: 760, sat_math_75_pctl: 800, act_composite_25_pctl: 34, act_composite_75_pctl: 36, sat_percent_submitting: 55, act_percent_submitting: 28, sat_crit_read_50_pctl: 760, sat_math_50_pctl: 790, act_composite_50_pctl: 35, open_admissions_policy: 0 }], 2022, idFor);
  assert.equal(req.find((x) => x.field === 'sat_total_25_approx').value_num, 1490);
  assert.equal(req.find((x) => x.field === 'test_policy_ipeds').value_text, 'Neither required nor recommended');
  // UMass Amherst 2023: tuition_type 3 = in-state 17,357; 4 = out-of-state 39,293
  const tu = T.tuitionStats([{ unitid: 166629, level_of_study: 1, tuition_type: 2, tuition_fees_ft: 17357 }, { unitid: 166629, level_of_study: 1, tuition_type: 3, tuition_fees_ft: 17357 }, { unitid: 166629, level_of_study: 1, tuition_type: 4, tuition_fees_ft: 39293 }, { unitid: 166629, level_of_study: 2, tuition_type: 4, tuition_fees_ft: 1 }], 2023, idFor);
  assert.deepEqual(tu.map((x) => [x.field, x.value_num]), [['tuition_in_district', 17357], ['tuition_in_state', 17357], ['tuition_out_of_state', 39293]]);
  const gr = T.gradStats([{ unitid: 166629, race: 99, sex: 99, subcohort: 2, completion_rate_150pct: 0.83 }, { unitid: 166629, race: 99, sex: 99, subcohort: 99, completion_rate_150pct: 0.83, cohort_year: 2017 }], 2023, idFor);
  assert.equal(gr.length, 1); assert.equal(gr[0].value_num, 0.83);
  const en = T.enrollmentStats([{ unitid: 166629, race: 99, sex: 99, ftpt: 99, degree_seeking: 99, class_level: 99, enrollment_fall: 23920 }, { unitid: 166629, race: 99, sex: 99, ftpt: 99, degree_seeking: 1, class_level: 99, enrollment_fall: 23671 }], 2024, idFor);
  assert.deepEqual(en.map((x) => x.value_num), [23920]);
  const ret = T.retentionStats([{ unitid: 166027, ftpt: 2, retention_rate: -2 }, { unitid: 166027, ftpt: 1, retention_rate: 0.98 }], 2024, idFor);
  assert.deepEqual(ret.map((x) => x.value_num), [0.98]);
  const np = T.netPriceStats([{ unitid: 166027, type_of_aid: 3, income_level: 99, level_of_study: 1, net_price: 19491 }, { unitid: 166027, type_of_aid: 9, income_level: 99, level_of_study: 1, net_price: null }], 2021, idFor);
  assert.deepEqual(np.map((x) => x.value_num), [19491]);
  // Unknown institutions are dropped, never guessed
  assert.equal(T.ratioStats([{ unitid: 1, student_faculty_ratio: 7 }], 2024, () => null).length, 0);
});

test('conflicts are reported, not resolved', () => {
  const c = T.findConflicts([{ college_id: 'a', field: 'admit_rate', value_num: 0.04, reporting_year: '2024' }], [{ college_id: 'a', field: 'admit_rate', value_num: 0.05, reporting_year: '2023' }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].observations.length, 2);
  assert.equal(T.findConflicts([{ college_id: 'a', field: 'x', value_num: 100 }], [{ college_id: 'a', field: 'x', value_num: 101 }]).length, 0);
});

test('BLS OOH XML parsing', () => {
  const xml = `<ooh><current_year>2025</current_year><projection_year>2035</projection_year><reference_period>May 2025</reference_period><last_updated>10/29/2026</last_updated>
  <occupation><title type="text">Accountants and Auditors</title><description type="text">Accountants and auditors prepare and examine financial records.</description><occupation_code>B047</occupation_code>
  <soc_coverage><soc_code type="text">13-2011</soc_code></soc_coverage><publish_date type="date">2026-10-29</publish_date>
  <quick_facts><qf_median_pay_annual><value type="int">83680</value></qf_median_pay_annual><qf_median_pay_hourly><value>40.23</value></qf_median_pay_hourly>
  <qf_entry_level_education><value>Bachelor&apos;s degree</value></qf_entry_level_education><qf_work_experience><value>None</value></qf_work_experience>
  <qf_number_of_jobs><value type="int">1595200</value></qf_number_of_jobs><qf_employment_outlook><value type="int">5</value><description>Faster than average</description></qf_employment_outlook>
  <qf_employment_openings><value>79400</value></qf_employment_openings></quick_facts>
  <similar_occupations><![CDATA[<a href="https://www.bls.gov/ooh/business-and-financial/budget-analysts.htm">Budget analysts</a>]]></similar_occupations>
  <citation><![CDATA[<p>Bureau of Labor Statistics, <a href="https://www.bls.gov/ooh/business-and-financial/accountants-and-auditors.htm">here</a></p>]]></citation></occupation>
  <occupation><title>Actors</title><occupation_code>B151</occupation_code><description>Actors express ideas.</description><soc_coverage><soc_code>27-2011</soc_code></soc_coverage>
  <quick_facts><qf_median_pay_annual><value type="int"></value></qf_median_pay_annual><qf_median_pay_hourly><value>29.05</value></qf_median_pay_hourly></quick_facts>
  <citation><a href="https://www.bls.gov/ooh/entertainment-and-sports/actors.htm">x</a></citation></occupation></ooh>`;
  const { meta, careers } = T.parseOOH(xml);
  assert.equal(meta.projectionYear, '2035');
  assert.equal(careers.length, 2);
  assert.equal(careers[0].median_pay_annual, 83680);
  assert.equal(careers[0].entry_education, "Bachelor's degree");
  assert.equal(careers[0].projected_change_pct, 5);
  assert.equal(careers[0].outlook_label, 'Faster than average');
  assert.equal(careers[0].projection_period, '2025–2035');
  assert.equal(careers[1].median_pay_annual, null, 'blank pay stays blank (actors are paid hourly)');
  const src = T.careerSource(careers[0], meta);
  assert.equal(src.reliability_tier, 1);
  assert.equal(src.url_normalized, 'https://bls.gov/ooh/business-and-financial/accountants-and-auditors.htm');
});

test('CIP CSV parsing handles NCES Excel wrappers and quoted commas', () => {
  const csv = 'CIPFamily,CIPCode,Action,TextChange,CIPTitle,CIPDefinition,CrossReferences,Examples\r\n="11",="11",No substantive changes,No,"COMPUTER AND INFORMATION SCIENCES AND SUPPORT SERVICES.","Instructional programs that focus on computers, computing.",,\r\n="11",="11.0701",No substantive changes,No,"Computer Science.","A program that focuses on the theory, design and uses of computers.",,\r\n="11",="11.0199",Deleted,No,"Old Program.","x",,\r\n';
  const majors = T.cipToMajors(T.parseCSV(csv));
  assert.equal(majors.length, 1);
  assert.equal(majors[0].cip_code, '11.0701');
  assert.equal(majors[0].title, 'Computer Science');
  assert.equal(majors[0].family_title, 'Computer and Information Sciences and Support Services');
  assert.match(majors[0].definition, /theory, design/);
});

test('completions → college majors (totals only, no blanks)', () => {
  const rows = T.completionsToCollegeMajors([{ unitid: 166629, cipcode_6digit: 110701, award_level: 7, race: 99, sex: 99, majornum: 1, awards_6digit: 412 }, { unitid: 166629, cipcode_6digit: 99, award_level: 7, race: 99, sex: 99, majornum: 1, awards_6digit: 5000 }, { unitid: 166629, cipcode_6digit: 90101, award_level: 7, race: 99, sex: 99, majornum: 1, awards_6digit: 0 }], 2023, String);
  assert.deepEqual(rows, [{ college_id: '166629', cip_code: '11.0701', award_level: 7, completions: 412, data_year: 2023 }]);
});

test('chunkText splits on sentences with overlap', () => {
  const t = 'Sentence one is here. '.repeat(200);
  const c = T.chunkText(t, 500, 50);
  assert.ok(c.length > 5 && c.every((x) => x.length <= 500));
  assert.deepEqual(T.chunkText(''), []);
});
