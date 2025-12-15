/**
 * Shared types for canvas export data contract
 * Used by both render-api (plugin) and canvas.ts (frontend)
 */

/** Bounds data exported from render-api, consumed by frontend */
export interface CanvasExportBounds {
	minX: number;
	minY: number;
	width: number;
	height: number;
	/** @deprecated Use width/height instead. Kept for legacy compatibility */
	maxX?: number;
	/** @deprecated Use width/height instead. Kept for legacy compatibility */
	maxY?: number;
}

/** Node geometry data exported from render-api */
export interface CanvasNodeGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Full canvas export data embedded in HTML data attributes */
export interface CanvasExportData {
	bounds: CanvasExportBounds;
	viewportWidth?: number;
	viewportHeight?: number;
}

/** Data attribute names - single source of truth */
export const CANVAS_DATA_ATTRS = {
	// Canvas element attributes
	BOUNDS_MIN_X: 'data-bounds-min-x',
	BOUNDS_MIN_Y: 'data-bounds-min-y',
	BOUNDS_WIDTH: 'data-bounds-width',
	BOUNDS_HEIGHT: 'data-bounds-height',
	BOUNDS_MAX_X: 'data-bounds-max-x', // legacy
	BOUNDS_MAX_Y: 'data-bounds-max-y', // legacy
	
	// Node element attributes
	NODE_X: 'data-x',
	NODE_Y: 'data-y',
	NODE_WIDTH: 'data-width',
	NODE_HEIGHT: 'data-height',
} as const;

/** Parse canvas bounds from element data attributes */
export function parseCanvasBounds(canvasEl: HTMLElement): CanvasExportBounds | null {
	const minX = canvasEl.getAttribute(CANVAS_DATA_ATTRS.BOUNDS_MIN_X);
	const minY = canvasEl.getAttribute(CANVAS_DATA_ATTRS.BOUNDS_MIN_Y);
	const width = canvasEl.getAttribute(CANVAS_DATA_ATTRS.BOUNDS_WIDTH);
	const height = canvasEl.getAttribute(CANVAS_DATA_ATTRS.BOUNDS_HEIGHT);

	if (minX !== null && minY !== null && width !== null && height !== null) {
		return {
			minX: parseFloat(minX),
			minY: parseFloat(minY),
			width: parseFloat(width),
			height: parseFloat(height),
		};
	}

	// Fallback: legacy format with max values
	const maxX = canvasEl.getAttribute(CANVAS_DATA_ATTRS.BOUNDS_MAX_X);
	const maxY = canvasEl.getAttribute(CANVAS_DATA_ATTRS.BOUNDS_MAX_Y);
	if (minX !== null && minY !== null && maxX !== null && maxY !== null) {
		const x = parseFloat(minX);
		const y = parseFloat(minY);
		return {
			minX: x,
			minY: y,
			width: parseFloat(maxX) - x,
			height: parseFloat(maxY) - y,
		};
	}

	return null;
}

/** Parse node geometry from element data attributes */
export function parseNodeGeometry(nodeEl: HTMLElement): CanvasNodeGeometry {
	return {
		x: parseFloat(nodeEl.getAttribute(CANVAS_DATA_ATTRS.NODE_X) ?? '0'),
		y: parseFloat(nodeEl.getAttribute(CANVAS_DATA_ATTRS.NODE_Y) ?? '0'),
		width: parseFloat(nodeEl.getAttribute(CANVAS_DATA_ATTRS.NODE_WIDTH) ?? '0'),
		height: parseFloat(nodeEl.getAttribute(CANVAS_DATA_ATTRS.NODE_HEIGHT) ?? '0'),
	};
}
