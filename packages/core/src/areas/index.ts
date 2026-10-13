/** Areas (T-030): list, add, rename, archive ("hide") and restore. No delete (see ./areas.ts). */
export {
  AREA_NAME_MAX,
  type AreaListView,
  AreaName,
  type AreaNameTaken,
  type AreaView,
  archiveArea,
  createArea,
  listAreas,
  renameArea,
  restoreArea,
} from "./areas";
