// Rows this change measures where they differ from beta's MEASURED_COUNTS; each states the beta row,
// the delta and the reason. Columns: data SQL, setup SQL, other SQL, raw bytes, file reads, file bytes,
// YAML parses, index parses.
export const CHANGED_COUNTS: Record<string, { counts: readonly number[]; beta: readonly number[]; why: string }> = {
  // beta [0, 0, 0, 0, 1, 92, 1, 0]: fileReads +1, fileBytes +92, index +1
  "file/personas/1/initial/cold/findByName": { counts: [0, 0, 0, 0, 2, 184, 1, 1], beta: [0, 0, 0, 0, 1, 92, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 92, 1, 0]: fileReads +1, fileBytes +92, index +1
  "file/personas/1/initial/cold/details": { counts: [0, 0, 0, 0, 2, 184, 1, 1], beta: [0, 0, 0, 0, 1, 92, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +1, fileBytes +90, index +1
  "file/personas/1/edit/cold/findByName": { counts: [0, 0, 0, 0, 2, 180, 1, 1], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +1, fileBytes +90, index +1
  "file/personas/1/edit/cold/details": { counts: [0, 0, 0, 0, 2, 180, 1, 1], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +90, yaml +1
  "file/personas/1/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 90, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 1, 92, 1, 0]: fileReads +10, fileBytes +920, index +10
  "file/personas/10/initial/cold/findByName": { counts: [0, 0, 0, 0, 11, 1012, 1, 10], beta: [0, 0, 0, 0, 1, 92, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 92, 1, 0]: fileReads +10, fileBytes +920, index +10
  "file/personas/10/initial/cold/details": { counts: [0, 0, 0, 0, 11, 1012, 1, 10], beta: [0, 0, 0, 0, 1, 92, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +10, fileBytes +918, index +10
  "file/personas/10/edit/cold/findByName": { counts: [0, 0, 0, 0, 11, 1008, 1, 10], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +10, fileBytes +918, index +10
  "file/personas/10/edit/cold/details": { counts: [0, 0, 0, 0, 11, 1008, 1, 10], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +90, yaml +1
  "file/personas/10/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 90, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 18, 1656, 9, 9]: fileReads -9, fileBytes -828, yaml -9
  "file/personas/10/delete/cold/findByName": { counts: [0, 0, 0, 0, 9, 828, 0, 9], beta: [0, 0, 0, 0, 18, 1656, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 18, 1656, 9, 9]: fileReads -9, fileBytes -828, yaml -9
  "file/personas/10/delete/cold/details": { counts: [0, 0, 0, 0, 9, 828, 0, 9], beta: [0, 0, 0, 0, 18, 1656, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +1, fileBytes +90, index +1
  "file/skills/1/initial/cold/findByName": { counts: [0, 0, 0, 0, 2, 180, 1, 1], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 88, 1, 0]: fileReads +1, fileBytes +88, index +1
  "file/skills/1/edit/cold/findByName": { counts: [0, 0, 0, 0, 2, 176, 1, 1], beta: [0, 0, 0, 0, 1, 88, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +88, yaml +1
  "file/skills/1/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 88, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +10, fileBytes +900, index +10
  "file/skills/10/initial/cold/findByName": { counts: [0, 0, 0, 0, 11, 990, 1, 10], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 1800, 10, 10]: fileReads -9, fileBytes -810, yaml -9
  "file/skills/10/initial/cold/details": { counts: [0, 0, 0, 0, 11, 990, 1, 10], beta: [0, 0, 0, 0, 20, 1800, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 88, 1, 0]: fileReads +10, fileBytes +898, index +10
  "file/skills/10/edit/cold/findByName": { counts: [0, 0, 0, 0, 11, 986, 1, 10], beta: [0, 0, 0, 0, 1, 88, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 1796, 10, 10]: fileReads -9, fileBytes -810, yaml -9
  "file/skills/10/edit/cold/details": { counts: [0, 0, 0, 0, 11, 986, 1, 10], beta: [0, 0, 0, 0, 20, 1796, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +88, yaml +1
  "file/skills/10/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 88, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 18, 1620, 9, 9]: fileReads -9, fileBytes -810, yaml -9
  "file/skills/10/delete/cold/findByName": { counts: [0, 0, 0, 0, 9, 810, 0, 9], beta: [0, 0, 0, 0, 18, 1620, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 18, 1620, 9, 9]: fileReads -9, fileBytes -810, yaml -9
  "file/skills/10/delete/cold/details": { counts: [0, 0, 0, 0, 9, 810, 0, 9], beta: [0, 0, 0, 0, 18, 1620, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 106, 1, 0]: fileReads +1, fileBytes +106, index +1
  "file/ensembles/1/initial/cold/findByName": { counts: [0, 0, 0, 0, 2, 212, 1, 1], beta: [0, 0, 0, 0, 1, 106, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 104, 1, 0]: fileReads +1, fileBytes +104, index +1
  "file/ensembles/1/edit/cold/findByName": { counts: [0, 0, 0, 0, 2, 208, 1, 1], beta: [0, 0, 0, 0, 1, 104, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +104, yaml +1
  "file/ensembles/1/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 104, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 1, 106, 1, 0]: fileReads +10, fileBytes +1060, index +10
  "file/ensembles/10/initial/cold/findByName": { counts: [0, 0, 0, 0, 11, 1166, 1, 10], beta: [0, 0, 0, 0, 1, 106, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 2120, 10, 10]: fileReads -9, fileBytes -954, yaml -9
  "file/ensembles/10/initial/cold/details": { counts: [0, 0, 0, 0, 11, 1166, 1, 10], beta: [0, 0, 0, 0, 20, 2120, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 104, 1, 0]: fileReads +10, fileBytes +1058, index +10
  "file/ensembles/10/edit/cold/findByName": { counts: [0, 0, 0, 0, 11, 1162, 1, 10], beta: [0, 0, 0, 0, 1, 104, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 2116, 10, 10]: fileReads -9, fileBytes -954, yaml -9
  "file/ensembles/10/edit/cold/details": { counts: [0, 0, 0, 0, 11, 1162, 1, 10], beta: [0, 0, 0, 0, 20, 2116, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +104, yaml +1
  "file/ensembles/10/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 104, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 18, 1908, 9, 9]: fileReads -9, fileBytes -954, yaml -9
  "file/ensembles/10/delete/cold/findByName": { counts: [0, 0, 0, 0, 9, 954, 0, 9], beta: [0, 0, 0, 0, 18, 1908, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 18, 1908, 9, 9]: fileReads -9, fileBytes -954, yaml -9
  "file/ensembles/10/delete/cold/details": { counts: [0, 0, 0, 0, 9, 954, 0, 9], beta: [0, 0, 0, 0, 18, 1908, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +1, fileBytes +90, index +1
  "file/agents/1/initial/cold/findByName": { counts: [0, 0, 0, 0, 2, 180, 1, 1], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 88, 1, 0]: fileReads +1, fileBytes +88, index +1
  "file/agents/1/edit/cold/findByName": { counts: [0, 0, 0, 0, 2, 176, 1, 1], beta: [0, 0, 0, 0, 1, 88, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +88, yaml +1
  "file/agents/1/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 88, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 1, 90, 1, 0]: fileReads +10, fileBytes +900, index +10
  "file/agents/10/initial/cold/findByName": { counts: [0, 0, 0, 0, 11, 990, 1, 10], beta: [0, 0, 0, 0, 1, 90, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 1800, 10, 10]: fileReads -9, fileBytes -810, yaml -9
  "file/agents/10/initial/cold/details": { counts: [0, 0, 0, 0, 11, 990, 1, 10], beta: [0, 0, 0, 0, 20, 1800, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 88, 1, 0]: fileReads +10, fileBytes +898, index +10
  "file/agents/10/edit/cold/findByName": { counts: [0, 0, 0, 0, 11, 986, 1, 10], beta: [0, 0, 0, 0, 1, 88, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 1796, 10, 10]: fileReads -9, fileBytes -810, yaml -9
  "file/agents/10/edit/cold/details": { counts: [0, 0, 0, 0, 11, 986, 1, 10], beta: [0, 0, 0, 0, 20, 1796, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +88, yaml +1
  "file/agents/10/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 88, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 18, 1620, 9, 9]: fileReads -9, fileBytes -810, yaml -9
  "file/agents/10/delete/cold/findByName": { counts: [0, 0, 0, 0, 9, 810, 0, 9], beta: [0, 0, 0, 0, 18, 1620, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 18, 1620, 9, 9]: fileReads -9, fileBytes -810, yaml -9
  "file/agents/10/delete/cold/details": { counts: [0, 0, 0, 0, 9, 810, 0, 9], beta: [0, 0, 0, 0, 18, 1620, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 93, 1, 0]: fileReads +1, fileBytes +93, index +1
  "file/templates/1/initial/cold/findByName": { counts: [0, 0, 0, 0, 2, 186, 1, 1], beta: [0, 0, 0, 0, 1, 93, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 91, 1, 0]: fileReads +1, fileBytes +91, index +1
  "file/templates/1/edit/cold/findByName": { counts: [0, 0, 0, 0, 2, 182, 1, 1], beta: [0, 0, 0, 0, 1, 91, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +91, yaml +1
  "file/templates/1/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 91, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 1, 93, 1, 0]: fileReads +10, fileBytes +930, index +10
  "file/templates/10/initial/cold/findByName": { counts: [0, 0, 0, 0, 11, 1023, 1, 10], beta: [0, 0, 0, 0, 1, 93, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 1860, 10, 10]: fileReads -9, fileBytes -837, yaml -9
  "file/templates/10/initial/cold/details": { counts: [0, 0, 0, 0, 11, 1023, 1, 10], beta: [0, 0, 0, 0, 20, 1860, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 1, 91, 1, 0]: fileReads +10, fileBytes +928, index +10
  "file/templates/10/edit/cold/findByName": { counts: [0, 0, 0, 0, 11, 1019, 1, 10], beta: [0, 0, 0, 0, 1, 91, 1, 0], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 20, 1856, 10, 10]: fileReads -9, fileBytes -837, yaml -9
  "file/templates/10/edit/cold/details": { counts: [0, 0, 0, 0, 11, 1019, 1, 10], beta: [0, 0, 0, 0, 20, 1856, 10, 10], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 0, 0, 0, 0]: fileReads +1, fileBytes +91, yaml +1
  "file/templates/10/edit/warm/findByName": { counts: [0, 0, 0, 0, 1, 91, 1, 0], beta: [0, 0, 0, 0, 0, 0, 0, 0], why: "The external edit is seen: the edited body is read again (the file layer vouches only for an unchanged file)." },
  // beta [0, 0, 0, 0, 18, 1674, 9, 9]: fileReads -9, fileBytes -837, yaml -9
  "file/templates/10/delete/cold/findByName": { counts: [0, 0, 0, 0, 9, 837, 0, 9], beta: [0, 0, 0, 0, 18, 1674, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [0, 0, 0, 0, 18, 1674, 9, 9]: fileReads -9, fileBytes -837, yaml -9
  "file/templates/10/delete/cold/details": { counts: [0, 0, 0, 0, 9, 837, 0, 9], beta: [0, 0, 0, 0, 18, 1674, 9, 9], why: "A cold lookup reads the pinned metadata scan, then hydrates only the selected definition." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/personas/0/initial/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/personas/0/initial/cold/details": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 92, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/1/initial/cold/findByName": { counts: [4, 12, 0, 92, 0, 0, 1, 0], beta: [2, 8, 0, 92, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 92, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/1/initial/cold/details": { counts: [4, 12, 0, 92, 0, 0, 1, 0], beta: [2, 8, 0, 92, 0, 0, 1, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/1/edit/cold/findByName": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/1/edit/cold/details": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/personas/1/delete/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/personas/1/delete/cold/details": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 92, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/10/initial/cold/findByName": { counts: [4, 12, 0, 92, 0, 0, 1, 0], beta: [2, 8, 0, 92, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 92, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/10/initial/cold/details": { counts: [4, 12, 0, 92, 0, 0, 1, 0], beta: [2, 8, 0, 92, 0, 0, 1, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/10/edit/cold/findByName": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/personas/10/edit/cold/details": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +2, setup +4
  "db/personas/10/delete/cold/findByName": { counts: [3, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +2, setup +4
  "db/personas/10/delete/cold/details": { counts: [3, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/skills/0/initial/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 0, 0, 0, 0, 0]: data -1, setup -4
  "db/skills/0/initial/warm/details": { counts: [1, 4, 0, 0, 0, 0, 0, 0], beta: [2, 8, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/skills/1/initial/cold/findByName": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +90, yaml +1
  "db/skills/1/initial/warm/details": { counts: [1,  4,  0,  90,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 88, 0, 0, 1, 0]: data +2, setup +4
  "db/skills/1/edit/cold/findByName": { counts: [4, 12, 0, 88, 0, 0, 1, 0], beta: [2, 8, 0, 88, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [4,  12,  0,  88,  0,  0,  1,  0]: data -3, setup -8
  "db/skills/1/edit/warm/details": { counts: [1,  4,  0,  88,  0,  0,  1,  0], beta: [4,  12,  0,  88,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/skills/1/delete/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/skills/10/initial/cold/findByName": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  900,  0,  0,  10,  0]: data -9, setup -36, raw -810, yaml -9
  "db/skills/10/initial/cold/details": { counts: [4,  12,  0,  90,  0,  0,  1,  0], beta: [13,  48,  0,  900,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +90, yaml +1
  "db/skills/10/initial/warm/details": { counts: [1,  4,  0,  90,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 88, 0, 0, 1, 0]: data +2, setup +4
  "db/skills/10/edit/cold/findByName": { counts: [4, 12, 0, 88, 0, 0, 1, 0], beta: [2, 8, 0, 88, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  898,  0,  0,  10,  0]: data -9, setup -36, raw -810, yaml -9
  "db/skills/10/edit/cold/details": { counts: [4,  12,  0,  88,  0,  0,  1,  0], beta: [13,  48,  0,  898,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [4,  12,  0,  88,  0,  0,  1,  0]: data -3, setup -8
  "db/skills/10/edit/warm/details": { counts: [1,  4,  0,  88,  0,  0,  1,  0], beta: [4,  12,  0,  88,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +2, setup +4
  "db/skills/10/delete/cold/findByName": { counts: [3, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [12,  44,  0,  810,  0,  0,  9,  0]: data -9, setup -36, raw -810, yaml -9
  "db/skills/10/delete/cold/details": { counts: [3,  8,  0,  0,  0,  0,  0,  0], beta: [12,  44,  0,  810,  0,  0,  9,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -1
  "db/skills/10/delete/warm/details": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/ensembles/0/initial/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 0, 0, 0, 0, 0]: data -1, setup -4
  "db/ensembles/0/initial/warm/details": { counts: [1, 4, 0, 0, 0, 0, 0, 0], beta: [2, 8, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 106, 0, 0, 1, 0]: data +2, setup +4
  "db/ensembles/1/initial/cold/findByName": { counts: [4, 12, 0, 106, 0, 0, 1, 0], beta: [2, 8, 0, 106, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +106, yaml +1
  "db/ensembles/1/initial/warm/details": { counts: [1,  4,  0,  106,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 104, 0, 0, 1, 0]: data +2, setup +4
  "db/ensembles/1/edit/cold/findByName": { counts: [4, 12, 0, 104, 0, 0, 1, 0], beta: [2, 8, 0, 104, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [4,  12,  0,  104,  0,  0,  1,  0]: data -3, setup -8
  "db/ensembles/1/edit/warm/details": { counts: [1,  4,  0,  104,  0,  0,  1,  0], beta: [4,  12,  0,  104,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/ensembles/1/delete/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 106, 0, 0, 1, 0]: data +2, setup +4
  "db/ensembles/10/initial/cold/findByName": { counts: [4, 12, 0, 106, 0, 0, 1, 0], beta: [2, 8, 0, 106, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  1060,  0,  0,  10,  0]: data -9, setup -36, raw -954, yaml -9
  "db/ensembles/10/initial/cold/details": { counts: [4,  12,  0,  106,  0,  0,  1,  0], beta: [13,  48,  0,  1060,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +106, yaml +1
  "db/ensembles/10/initial/warm/details": { counts: [1,  4,  0,  106,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 104, 0, 0, 1, 0]: data +2, setup +4
  "db/ensembles/10/edit/cold/findByName": { counts: [4, 12, 0, 104, 0, 0, 1, 0], beta: [2, 8, 0, 104, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  1058,  0,  0,  10,  0]: data -9, setup -36, raw -954, yaml -9
  "db/ensembles/10/edit/cold/details": { counts: [4,  12,  0,  104,  0,  0,  1,  0], beta: [13,  48,  0,  1058,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [4,  12,  0,  104,  0,  0,  1,  0]: data -3, setup -8
  "db/ensembles/10/edit/warm/details": { counts: [1,  4,  0,  104,  0,  0,  1,  0], beta: [4,  12,  0,  104,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +2, setup +4
  "db/ensembles/10/delete/cold/findByName": { counts: [3, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [12,  44,  0,  954,  0,  0,  9,  0]: data -9, setup -36, raw -954, yaml -9
  "db/ensembles/10/delete/cold/details": { counts: [3,  8,  0,  0,  0,  0,  0,  0], beta: [12,  44,  0,  954,  0,  0,  9,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -1
  "db/ensembles/10/delete/warm/details": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/agents/0/initial/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 0, 0, 0, 0, 0]: data -1, setup -4
  "db/agents/0/initial/warm/details": { counts: [1, 4, 0, 0, 0, 0, 0, 0], beta: [2, 8, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/agents/1/initial/cold/findByName": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +90, yaml +1
  "db/agents/1/initial/warm/details": { counts: [1,  4,  0,  90,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 88, 0, 0, 1, 0]: data +2, setup +4
  "db/agents/1/edit/cold/findByName": { counts: [4, 12, 0, 88, 0, 0, 1, 0], beta: [2, 8, 0, 88, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [4,  12,  0,  88,  0,  0,  1,  0]: data -3, setup -8
  "db/agents/1/edit/warm/details": { counts: [1,  4,  0,  88,  0,  0,  1,  0], beta: [4,  12,  0,  88,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/agents/1/delete/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 90, 0, 0, 1, 0]: data +2, setup +4
  "db/agents/10/initial/cold/findByName": { counts: [4, 12, 0, 90, 0, 0, 1, 0], beta: [2, 8, 0, 90, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  900,  0,  0,  10,  0]: data -9, setup -36, raw -810, yaml -9
  "db/agents/10/initial/cold/details": { counts: [4,  12,  0,  90,  0,  0,  1,  0], beta: [13,  48,  0,  900,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +90, yaml +1
  "db/agents/10/initial/warm/details": { counts: [1,  4,  0,  90,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 88, 0, 0, 1, 0]: data +2, setup +4
  "db/agents/10/edit/cold/findByName": { counts: [4, 12, 0, 88, 0, 0, 1, 0], beta: [2, 8, 0, 88, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  898,  0,  0,  10,  0]: data -9, setup -36, raw -810, yaml -9
  "db/agents/10/edit/cold/details": { counts: [4,  12,  0,  88,  0,  0,  1,  0], beta: [13,  48,  0,  898,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [4,  12,  0,  88,  0,  0,  1,  0]: data -3, setup -8
  "db/agents/10/edit/warm/details": { counts: [1,  4,  0,  88,  0,  0,  1,  0], beta: [4,  12,  0,  88,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +2, setup +4
  "db/agents/10/delete/cold/findByName": { counts: [3, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [12,  44,  0,  810,  0,  0,  9,  0]: data -9, setup -36, raw -810, yaml -9
  "db/agents/10/delete/cold/details": { counts: [3,  8,  0,  0,  0,  0,  0,  0], beta: [12,  44,  0,  810,  0,  0,  9,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -1
  "db/agents/10/delete/warm/details": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/templates/0/initial/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 0, 0, 0, 0, 0]: data -1, setup -4
  "db/templates/0/initial/warm/details": { counts: [1, 4, 0, 0, 0, 0, 0, 0], beta: [2, 8, 0, 0, 0, 0, 0, 0], why: "Details refresh the row identities, then read only the selected body; no summary or tag query." },
  // beta [2, 8, 0, 93, 0, 0, 1, 0]: data +2, setup +4
  "db/templates/1/initial/cold/findByName": { counts: [4, 12, 0, 93, 0, 0, 1, 0], beta: [2, 8, 0, 93, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +93, yaml +1
  "db/templates/1/initial/warm/details": { counts: [1,  4,  0,  93,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 91, 0, 0, 1, 0]: data +2, setup +4
  "db/templates/1/edit/cold/findByName": { counts: [4, 12, 0, 91, 0, 0, 1, 0], beta: [2, 8, 0, 91, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [4,  12,  0,  91,  0,  0,  1,  0]: data -3, setup -8
  "db/templates/1/edit/warm/details": { counts: [1,  4,  0,  91,  0,  0,  1,  0], beta: [4,  12,  0,  91,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +1, setup +4
  "db/templates/1/delete/cold/findByName": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [2, 8, 0, 93, 0, 0, 1, 0]: data +2, setup +4
  "db/templates/10/initial/cold/findByName": { counts: [4, 12, 0, 93, 0, 0, 1, 0], beta: [2, 8, 0, 93, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  930,  0,  0,  10,  0]: data -9, setup -36, raw -837, yaml -9
  "db/templates/10/initial/cold/details": { counts: [4,  12,  0,  93,  0,  0,  1,  0], beta: [13,  48,  0,  930,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -2, setup -4, raw +93, yaml +1
  "db/templates/10/initial/warm/details": { counts: [1,  4,  0,  93,  0,  0,  1,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [2, 8, 0, 91, 0, 0, 1, 0]: data +2, setup +4
  "db/templates/10/edit/cold/findByName": { counts: [4, 12, 0, 91, 0, 0, 1, 0], beta: [2, 8, 0, 91, 0, 0, 1, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [13,  48,  0,  928,  0,  0,  10,  0]: data -9, setup -36, raw -837, yaml -9
  "db/templates/10/edit/cold/details": { counts: [4,  12,  0,  91,  0,  0,  1,  0], beta: [13,  48,  0,  928,  0,  0,  10,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [4,  12,  0,  91,  0,  0,  1,  0]: data -3, setup -8
  "db/templates/10/edit/warm/details": { counts: [1,  4,  0,  91,  0,  0,  1,  0], beta: [4,  12,  0,  91,  0,  0,  1,  0], why: "Details is the manager's own lookup: the selected row is read once by id; beta's handler listed the collection first." },
  // beta [1, 4, 0, 0, 0, 0, 0, 0]: data +2, setup +4
  "db/templates/10/delete/cold/findByName": { counts: [3, 8, 0, 0, 0, 0, 0, 0], beta: [1, 4, 0, 0, 0, 0, 0, 0], why: "A cold lookup reads the pinned id and name scan, then only the selected row; beta read every row." },
  // beta [12,  44,  0,  837,  0,  0,  9,  0]: data -9, setup -36, raw -837, yaml -9
  "db/templates/10/delete/cold/details": { counts: [3,  8,  0,  0,  0,  0,  0,  0], beta: [12,  44,  0,  837,  0,  0,  9,  0], why: "A cold lookup certifies from one collection read, then hydrates only the selected row (none when absent)." },
  // beta [3,  8,  0,  0,  0,  0,  0,  0]: data -1
  "db/templates/10/delete/warm/details": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [3,  8,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [4, 16, 0, 0, 0, 0, 0, 0]: data -4, setup -16
  "db/agents/0/initial/cold/refresh": { counts: [0, 0, 0, 0, 0, 0, 0, 0], beta: [4, 16, 0, 0, 0, 0, 0, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [4, 16, 0, 0, 0, 0, 0, 0]: data -4, setup -16
  "db/agents/0/initial/warm/refresh": { counts: [0, 0, 0, 0, 0, 0, 0, 0], beta: [4, 16, 0, 0, 0, 0, 0, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [5, 20, 0, 90, 0, 0, 1, 0]: data -3, setup -12
  "db/agents/1/initial/cold/refresh": { counts: [2, 8, 0, 90, 0, 0, 1, 0], beta: [5, 20, 0, 90, 0, 0, 1, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [5, 20, 0, 90, 0, 0, 1, 0]: data -3, setup -12
  "db/agents/1/initial/warm/refresh": { counts: [2, 8, 0, 90, 0, 0, 1, 0], beta: [5, 20, 0, 90, 0, 0, 1, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [5, 20, 0, 88, 0, 0, 1, 0]: data -3, setup -12
  "db/agents/1/edit/cold/refresh": { counts: [2, 8, 0, 88, 0, 0, 1, 0], beta: [5, 20, 0, 88, 0, 0, 1, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [5, 20, 0, 88, 0, 0, 1, 0]: data -3, setup -12
  "db/agents/1/edit/warm/refresh": { counts: [2, 8, 0, 88, 0, 0, 1, 0], beta: [5, 20, 0, 88, 0, 0, 1, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [5, 20, 0, 0, 0, 0, 0, 0]: data -3, setup -12
  "db/agents/1/delete/cold/refresh": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [5, 20, 0, 0, 0, 0, 0, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [5, 20, 0, 0, 0, 0, 0, 0]: data -3, setup -12
  "db/agents/1/delete/warm/refresh": { counts: [2, 8, 0, 0, 0, 0, 0, 0], beta: [5, 20, 0, 0, 0, 0, 0, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [14, 56, 0, 900, 0, 0, 10, 0]: data -3, setup -12
  "db/agents/10/initial/cold/refresh": { counts: [11, 44, 0, 900, 0, 0, 10, 0], beta: [14, 56, 0, 900, 0, 0, 10, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [14, 56, 0, 900, 0, 0, 10, 0]: data -3, setup -12
  "db/agents/10/initial/warm/refresh": { counts: [11, 44, 0, 900, 0, 0, 10, 0], beta: [14, 56, 0, 900, 0, 0, 10, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [14, 56, 0, 898, 0, 0, 10, 0]: data -3, setup -12
  "db/agents/10/edit/cold/refresh": { counts: [11, 44, 0, 898, 0, 0, 10, 0], beta: [14, 56, 0, 898, 0, 0, 10, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [14, 56, 0, 898, 0, 0, 10, 0]: data -3, setup -12
  "db/agents/10/edit/warm/refresh": { counts: [11, 44, 0, 898, 0, 0, 10, 0], beta: [14, 56, 0, 898, 0, 0, 10, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [14, 56, 0, 810, 0, 0, 9, 0]: data -3, setup -12
  "db/agents/10/delete/cold/refresh": { counts: [11, 44, 0, 810, 0, 0, 9, 0], beta: [14, 56, 0, 810, 0, 0, 9, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [14, 56, 0, 810, 0, 0, 9, 0]: data -3, setup -12
  "db/agents/10/delete/warm/refresh": { counts: [11, 44, 0, 810, 0, 0, 9, 0], beta: [14, 56, 0, 810, 0, 0, 9, 0], why: "One full id scan replaces beta's three index scans; active rows are read by id." },
  // beta [0,  0,  0,  0,  2,  176,  1,  1]: fileReads -1, fileBytes -88, index -1
  "file/skills/1/edit/warm/details": { counts: [0,  0,  0,  0,  1,  88,  1,  0], beta: [0,  0,  0,  0,  2,  176,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  176,  1,  1]: fileReads -1, fileBytes -88, index -1
  "file/skills/10/edit/warm/details": { counts: [0,  0,  0,  0,  1,  88,  1,  0], beta: [0,  0,  0,  0,  2,  176,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  208,  1,  1]: fileReads -1, fileBytes -104, index -1
  "file/ensembles/1/edit/warm/details": { counts: [0,  0,  0,  0,  1,  104,  1,  0], beta: [0,  0,  0,  0,  2,  208,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  208,  1,  1]: fileReads -1, fileBytes -104, index -1
  "file/ensembles/10/edit/warm/details": { counts: [0,  0,  0,  0,  1,  104,  1,  0], beta: [0,  0,  0,  0,  2,  208,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  176,  1,  1]: fileReads -1, fileBytes -88, index -1
  "file/agents/1/edit/warm/details": { counts: [0,  0,  0,  0,  1,  88,  1,  0], beta: [0,  0,  0,  0,  2,  176,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  176,  1,  1]: fileReads -1, fileBytes -88, index -1
  "file/agents/10/edit/warm/details": { counts: [0,  0,  0,  0,  1,  88,  1,  0], beta: [0,  0,  0,  0,  2,  176,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  182,  1,  1]: fileReads -1, fileBytes -91, index -1
  "file/templates/1/edit/warm/details": { counts: [0,  0,  0,  0,  1,  91,  1,  0], beta: [0,  0,  0,  0,  2,  182,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  2,  182,  1,  1]: fileReads -1, fileBytes -91, index -1
  "file/templates/10/edit/warm/details": { counts: [0,  0,  0,  0,  1,  91,  1,  0], beta: [0,  0,  0,  0,  2,  182,  1,  1], why: "Details is the manager's own lookup (no handler-side listing): the edited body is read once, never the index again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/personas/0/initial/warm/findByName": { counts: [1,  4,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "A warm miss is confirmed by one incremental scan (rows another process wrote since the last scan) before it is answered absent." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/personas/0/initial/warm/details": { counts: [1,  4,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "A warm miss is confirmed by one incremental scan (rows another process wrote since the last scan) before it is answered absent." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/personas/1/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/personas/10/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/skills/0/initial/warm/findByName": { counts: [1,  4,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "A warm miss is confirmed by one incremental scan (rows another process wrote since the last scan) before it is answered absent." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/skills/1/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/skills/10/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/ensembles/0/initial/warm/findByName": { counts: [1,  4,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "A warm miss is confirmed by one incremental scan (rows another process wrote since the last scan) before it is answered absent." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/ensembles/1/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/ensembles/10/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/agents/0/initial/warm/findByName": { counts: [1,  4,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "A warm miss is confirmed by one incremental scan (rows another process wrote since the last scan) before it is answered absent." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/agents/1/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/agents/10/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/templates/0/initial/warm/findByName": { counts: [1,  4,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "A warm miss is confirmed by one incremental scan (rows another process wrote since the last scan) before it is answered absent." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/templates/1/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [1,  4,  0,  0,  0,  0,  0,  0]: data +1, setup +4
  "db/templates/10/delete/warm/findByName": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [1,  4,  0,  0,  0,  0,  0,  0], why: "The row was deleted elsewhere: the selected row reads absent, the index is rescanned once (the full id scan) and the name certified again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: fileReads +1, fileBytes +90, yaml +1
  "file/personas/1/edit/warm/details": { counts: [0,  0,  0,  0,  1,  90,  1,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "Persona details read through the shared read contract: a cached persona is served only while the file layer vouches it is current, so the edited definition is read again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: fileReads +1, fileBytes +90, yaml +1
  "file/personas/10/edit/warm/details": { counts: [0,  0,  0,  0,  1,  90,  1,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "Persona details read through the shared read contract: a cached persona is served only while the file layer vouches it is current, so the edited definition is read again." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4, raw +92, yaml +1
  "db/personas/1/initial/warm/details": { counts: [1,  4,  0,  92,  0,  0,  1,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "Persona details read through the shared read contract: the database never vouches for a cached row, so the selected persona is read by id." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4, raw +90, yaml +1
  "db/personas/1/edit/warm/details": { counts: [1,  4,  0,  90,  0,  0,  1,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "Persona details read through the shared read contract: the database never vouches for a cached row, so the selected persona is read by id." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4, raw +92, yaml +1
  "db/personas/10/initial/warm/details": { counts: [1,  4,  0,  92,  0,  0,  1,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "Persona details read through the shared read contract: the database never vouches for a cached row, so the selected persona is read by id." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +1, setup +4, raw +90, yaml +1
  "db/personas/10/edit/warm/details": { counts: [1,  4,  0,  90,  0,  0,  1,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "Persona details read through the shared read contract: the database never vouches for a cached row, so the selected persona is read by id." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +2, setup +8
  "db/personas/1/delete/warm/details": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "The persona row was deleted elsewhere: beta served the cached persona; the shared read contract reads it by id (absent), then observes the collection once before answering not found." },
  // beta [0,  0,  0,  0,  0,  0,  0,  0]: data +2, setup +8
  "db/personas/10/delete/warm/details": { counts: [2,  8,  0,  0,  0,  0,  0,  0], beta: [0,  0,  0,  0,  0,  0,  0,  0], why: "The persona row was deleted elsewhere: beta served the cached persona; the shared read contract reads it by id (absent), then observes the collection once before answering not found." },
};
