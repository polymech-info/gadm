/**
 * @polymech/gadm — TypeScript port of pygadm + gadm_wrapper.
 */
export { loadDatabase, getColumns, resetCache } from './database.js';
export { getNames } from './names.js';
export { getItems } from './items.js';
export { searchRegions, getBoundary, getRegionNames } from './wrapper.js';
export { buildTree, walkDFS, walkBFS, walkLevel, leaves, findNode } from './tree.js';
export { setGpkgPath, getBoundaryFromGpkg, getHierarchyByPoint, getHierarchyByPointFromCache, queryUniqueGidsInBbox } from './gpkg-reader.js';
export { getNeighbors, levelFromGid, parentAdminGid } from './neighbors.js';
export { simplifyBoundaryForMap, prepareBoundaryForMap, smoothCoastRing, smoothCoastGeometry, stripInteriorRings, dropSmallOuterIslands, ringMinWidthKm, MIN_OUTER_ISLAND_WIDTH_KM, } from './simplify-map.js';
export { enrichFeatureWithGHS } from './enrich-ghs.js';
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7O0dBRUc7QUFFSCxPQUFPLEVBQUUsWUFBWSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsTUFBTSxlQUFlLENBQUM7QUFHckUsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUd0QyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBR3RDLE9BQU8sRUFBRSxhQUFhLEVBQUUsV0FBVyxFQUFFLGNBQWMsRUFBRSxNQUFNLGNBQWMsQ0FBQztBQU8xRSxPQUFPLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFHckYsT0FBTyxFQUFFLFdBQVcsRUFBRSxtQkFBbUIsRUFBRSxtQkFBbUIsRUFBRSw0QkFBNEIsRUFBRSxxQkFBcUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBRzlJLE9BQU8sRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRzVFLE9BQU8sRUFDSCxzQkFBc0IsRUFDdEIscUJBQXFCLEVBQ3JCLGVBQWUsRUFDZixtQkFBbUIsRUFDbkIsa0JBQWtCLEVBQ2xCLHFCQUFxQixFQUNyQixjQUFjLEVBQ2QseUJBQXlCLEdBQzVCLE1BQU0sbUJBQW1CLENBQUM7QUFHM0IsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0saUJBQWlCLENBQUMifQ==