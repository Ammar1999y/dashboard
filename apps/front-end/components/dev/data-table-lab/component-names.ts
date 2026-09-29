const TABLE_COMPONENT =
  /DataTable|SortButton|HeaderOptions|MenuSections|Options$|Option$|ColumnItem|ShowAllItem|ColumnFilter|PageButton|^Lab|Skeleton|UrlSync|Faceted/;

export const isTableComponent = (name: string) => TABLE_COMPONENT.test(name);

/** The components that build each region, for explaining a stale region. */
export const REGION_COMPONENTS = {
  header: /^(DataTableHeader|DataTableHeaderRow|DataTableHeaderCell)$/,
  body: /^(DataTableBody|DataTableBodyRow|DataTableBodyCell)$/,
} as const;

/** Which checker results belong to which region. */
export const REGION_CHECKS = {
  header: /^(header|sort icon)/,
  body: /^(row set|cell|body state)/,
} as const;
