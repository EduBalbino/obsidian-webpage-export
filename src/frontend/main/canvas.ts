import { WebpageDocument } from "./document"
import { Bounds, Vector2 } from "./utils";
import { parseCanvasBounds, parseNodeGeometry, type CanvasNodeGeometry } from "../../shared/canvas-types";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const SCALE_MULTIPLIER_DEFAULT = 0.9;
const SMALL_SCALE_THRESHOLD = 0.15;
const WHEEL_SCALE_DIVISOR = 500;
const INTERACTION_IDLE_MS = 120;
const ANIMATION_DURATION_MS = 300;

/** Small-scale approach: 'class' for binary toggle, 'cssvar' for smooth interpolation */
export type SmallScaleApproach = 'class' | 'cssvar';

/** Configuration for A/B testing - can be set before Canvas construction */
export const CanvasConfig = {
	smallScaleApproach: 'class' as SmallScaleApproach,
};

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export enum NodeType {
	Markdown = "markdown",
	ExternalMarkdown = "external-markdown",
	Canvas = "canvas",
	Image = "image",
	Video = "video",
	Audio = "audio",
	Website = "website",
	Group = "group",
	None = "none"
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS NODE
// ═══════════════════════════════════════════════════════════════════════════

export class CanvasNode {
	public canvas: Canvas;
	public nodeEl: HTMLElement;
	public labelEl: HTMLElement;
	public containerEl: HTMLElement;
	public contentEl: HTMLElement;
	public type: NodeType;
	public document: WebpageDocument;
	public isFocused: boolean = false;

	private readonly _geometry: CanvasNodeGeometry;

	public get localPosition(): Vector2 { return new Vector2(this._geometry.x, this._geometry.y); }
	public get localSize(): Vector2 { return new Vector2(this._geometry.width, this._geometry.height); }

	public get label(): string {
		return this.labelEl?.textContent ?? "";
	}

	public set label(newLabel: string) {
		if (this.labelEl) this.labelEl.textContent = newLabel;
	}

	/** Get local bounds for this node (immutable after construction) */
	public get localBounds(): Bounds {
		return new Bounds(
			this._geometry.x,
			this._geometry.y,
			this._geometry.width,
			this._geometry.height
		);
	}

	/** Compute screen bounds on-demand (depends on current canvas transform) */
	public getScreenBounds(canvasScale: number, canvasPosition: Vector2): Bounds {
		return new Bounds(
			this._geometry.x * canvasScale + canvasPosition.x,
			this._geometry.y * canvasScale + canvasPosition.y,
			this._geometry.width * canvasScale,
			this._geometry.height * canvasScale
		);
	}

	constructor(canvas: Canvas, nodeEl: HTMLElement) {
		this.canvas = canvas;
		this.nodeEl = nodeEl;
		this.labelEl = nodeEl.querySelector(".canvas-node-label") as HTMLElement;
		this.containerEl = nodeEl.querySelector(".canvas-node-container") as HTMLElement;
		this.contentEl = nodeEl.querySelector(".canvas-node-content") as HTMLElement;

		// Read geometry from structured data attributes
		this._geometry = parseNodeGeometry(nodeEl);

		// Apply geometry - runtime owns transform/sizing
		nodeEl.style.transform = `translate3d(${this._geometry.x}px, ${this._geometry.y}px, 0)`;
		nodeEl.style.width = `${this._geometry.width}px`;
		nodeEl.style.height = `${this._geometry.height}px`;

		if (!this.containerEl || !this.contentEl) {
			console.error("Failed to find all required elements for canvas node", this);
			return;
		}

		this.type = this.detectNodeType();

		if (this.type === NodeType.ExternalMarkdown) {
			const documentEl = this.contentEl.querySelector(".obsidian-document");
			const documentObj = canvas.document.children.find((doc) => doc.documentEl === documentEl);
			if (documentObj) this.document = documentObj;
			else console.error("Failed to find document object for external markdown node", this);
		}

		this.initEvents();
	}

	private detectNodeType(): NodeType {
		const contentClasses = this.contentEl.classList;
		if (contentClasses.contains("image-embed")) return NodeType.Image;
		if (contentClasses.contains("video-embed")) return NodeType.Video;
		if (contentClasses.contains("audio-embed")) return NodeType.Audio;
		if (contentClasses.contains("markdown-embed") && contentClasses.contains("external-markdown-embed")) return NodeType.ExternalMarkdown;
		if (contentClasses.contains("markdown-embed")) return NodeType.Markdown;
		if (contentClasses.contains("canvas-embed")) return NodeType.Canvas;
		if (this.contentEl.firstElementChild?.tagName === "IFRAME") return NodeType.Website;
		if (this.nodeEl.classList.contains("canvas-node-group")) return NodeType.Group;
		return NodeType.None;
	}

	public focus(force: boolean = true): void {
		if (this.isFocused === force) return;
		if (this.canvas.focusedNode !== this) this.canvas.focusedNode?.focus(false);
		this.nodeEl.classList.toggle("is-focused", force);
		this.canvas.focusedNode = force ? this : null;
		this.isFocused = force;
	}

	private handlePointerLeave = (): void => {
		this.focus(false);
	};

	private initEvents(): void {
		this.nodeEl.addEventListener("dblclick", () => this.fitToView());

		this.nodeEl.addEventListener("pointerenter", (event: PointerEvent) => {
			this.focus(true);
			this.nodeEl.addEventListener("pointerleave", this.handlePointerLeave, { once: true });
			event.stopPropagation();
		});
	}

	public fitToView(): void {
		this.canvas.animateToView(this.localBounds, SCALE_MULTIPLIER_DEFAULT);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS
// ═══════════════════════════════════════════════════════════════════════════

export class Canvas {
	public document: WebpageDocument;
	public nodes: CanvasNode[];
	public canvasEl: HTMLElement;
	public wrapperEl: HTMLElement;
	public focusedNode: CanvasNode | null = null;

	// Transform state - current is what's rendered, target is where we're animating to
	private _position: Vector2 = new Vector2(0, 0);
	private _scale: number = 1;
	private _targetPosition: Vector2 = new Vector2(0, 0);
	private _targetScale: number = 1;

	// Cached local bounds - computed once, never changes
	private _cachedLocalBounds: Bounds | null = null;

	// Wrapper rect caching
	private _wrapperRect: DOMRect | null = null;
	private _wrapperRectDirty: boolean = true;
	private _resizeObserver: ResizeObserver | null = null;
	private readonly _handleRectDirty = () => { this._wrapperRectDirty = true; };

	// Interaction state
	private _isInteracting: boolean = false;
	private _interactionIdleTimeoutId: number | null = null;

	// Animation state - Web Animations API
	private _currentAnimation: Animation | null = null;

	// Scale class caching
	private _lastSmallScale: boolean = false;

	// Scale limits
	private readonly _minScale: number = 0.1;
	private readonly _maxScale: number = 5;
	public get minScale(): number { return this._minScale; }
	public get maxScale(): number { return this._maxScale; }

	// Public accessors
	public get scale(): number { return this._scale; }
	public get canvasPosition(): Vector2 { return this._position; }

	constructor(document: WebpageDocument) {
		this.document = document;

		// Setup wrapper with CSS classes (hidden until ready)
		const wrapperEl = document.documentEl.querySelector(".canvas-wrapper") as HTMLElement;
		wrapperEl.classList.add('canvas-export-mode');

		this.nodes = Array.from(document.documentEl.querySelectorAll(".canvas-node"))
			.map((nodeEl) => new CanvasNode(this, nodeEl as HTMLElement));

		// Apply document class for canvas-specific layout
		this.document.documentEl.classList.add('canvas-document');

		this.canvasEl = document.documentEl.querySelector(".canvas") as HTMLElement;
		this.wrapperEl = wrapperEl;

		// Enable appropriate small-scale approach
		if (CanvasConfig.smallScaleApproach === 'cssvar') {
			this.canvasEl.classList.add('small-scale-var');
		}

		// Read and cache bounds from export data
		this.initBoundsFromExport();

		// Setup wrapper rect caching
		this.refreshWrapperRect();
		this._resizeObserver = new ResizeObserver(this._handleRectDirty);
		this._resizeObserver.observe(this.wrapperEl);
		window.addEventListener("scroll", this._handleRectDirty, { capture: true, passive: true });

		this.initEvents();

		// Initial fit
		this.fitToView(this.getLocalBounds(), SCALE_MULTIPLIER_DEFAULT);

		// Reveal after geometry applied
		requestAnimationFrame(() => {
			this.wrapperEl.classList.add('canvas-ready');
		});
	}

	private initBoundsFromExport(): void {
		const bounds = parseCanvasBounds(this.canvasEl);
		if (bounds) {
			this._cachedLocalBounds = new Bounds(
				bounds.minX,
				bounds.minY,
				bounds.width,
				bounds.height
			);
		}
	}

	/** Get cached local bounds (computed once) */
	public getLocalBounds(): Bounds {
		if (this._cachedLocalBounds) {
			return this._cachedLocalBounds;
		}

		// Compute from nodes if not cached
		if (this.nodes.length === 0) {
			return new Bounds(0, 0, 0, 0);
		}

		const first = this.nodes[0];
		const bounds = new Bounds(
			first.localPosition.x,
			first.localPosition.y,
			first.localSize.x,
			first.localSize.y
		);

		for (let i = 1; i < this.nodes.length; i++) {
			bounds.encapsulate(this.nodes[i].localBounds);
		}

		this._cachedLocalBounds = bounds;
		return bounds;
	}

	/** Compute screen bounds on-demand */
	public getScreenBounds(): Bounds {
		if (this.nodes.length === 0) {
			return new Bounds(0, 0, 0, 0);
		}

		const first = this.nodes[0].getScreenBounds(this._scale, this._position);
		const bounds = new Bounds(first.left, first.top, first.width, first.height);

		for (let i = 1; i < this.nodes.length; i++) {
			const nodeBounds = this.nodes[i].getScreenBounds(this._scale, this._position);
			bounds.encapsulate(nodeBounds);
		}

		return bounds;
	}

	private refreshWrapperRect(): void {
		if (this._wrapperRectDirty || !this._wrapperRect) {
			this._wrapperRect = this.wrapperEl.getBoundingClientRect();
			this._wrapperRectDirty = false;
		}
	}

	private setInteracting(value: boolean): void {
		if (this._isInteracting === value) return;
		this._isInteracting = value;
		this.canvasEl.classList.toggle('is-interacting', value);
	}

	private bumpInteraction(): void {
		this.setInteracting(true);
		if (this._interactionIdleTimeoutId !== null) {
			clearTimeout(this._interactionIdleTimeoutId);
		}
		this._interactionIdleTimeoutId = window.setTimeout(() => {
			this.setInteracting(false);
			this._interactionIdleTimeoutId = null;
		}, INTERACTION_IDLE_MS);
	}

	private applyTransform(): void {
		this.canvasEl.style.transform = `translate3d(${this._position.x}px, ${this._position.y}px, 0) scale(${this._scale})`;
	}

	private updateSmallScaleClass(): void {
		if (CanvasConfig.smallScaleApproach === 'cssvar') {
			// CSS var approach: smooth interpolation
			const factor = Math.max(0, Math.min(1, (SMALL_SCALE_THRESHOLD - this._scale) / SMALL_SCALE_THRESHOLD));
			this.canvasEl.style.setProperty('--small-scale-factor', factor.toString());
		} else {
			// Class toggle approach: binary on/off
			const isSmallScale = this._scale < SMALL_SCALE_THRESHOLD;
			if (this._lastSmallScale !== isSmallScale) {
				this._lastSmallScale = isSmallScale;
				this.canvasEl.classList.toggle("small-scale", isSmallScale);
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// ANIMATION SYSTEM (Web Animations API)
	// ═══════════════════════════════════════════════════════════════════════

	/** Cancel any running animation */
	private cancelAnimation(): void {
		if (this._currentAnimation) {
			this._currentAnimation.cancel();
			this._currentAnimation = null;
		}
	}

	/** Animate to target position and scale using Web Animations API */
	private animateToTarget(targetPos: Vector2, targetScale: number, duration: number = ANIMATION_DURATION_MS): void {
		this.cancelAnimation();

		const startTransform = `translate3d(${this._position.x}px, ${this._position.y}px, 0) scale(${this._scale})`;
		const endTransform = `translate3d(${targetPos.x}px, ${targetPos.y}px, 0) scale(${targetScale})`;

		this._currentAnimation = this.canvasEl.animate(
			[{ transform: startTransform }, { transform: endTransform }],
			{
				duration,
				easing: 'cubic-bezier(0.4, 0, 0.2, 1)', // Material Design ease-out
				fill: 'forwards',
			}
		);

		// Update state when animation completes
		this._currentAnimation.finished
			.then(() => {
				this._position = targetPos;
				this._targetPosition = targetPos;
				this._scale = targetScale;
				this._targetScale = targetScale;
				this.updateSmallScaleClass();
				this.applyTransform(); // Commit final transform to style
				this._currentAnimation = null;
			})
			.catch(() => {
				// Animation was cancelled - state already updated by interrupting code
			});
	}

	/** Set target position (animates smoothly via WAAPI) */
	public setTargetPosition(pos: Vector2): void {
		this._targetPosition = pos;
		this.animateToTarget(pos, this._targetScale);
	}

	/** Set target scale (animates smoothly via WAAPI) */
	public setTargetScale(scale: number): void {
		this._targetScale = Math.min(Math.max(scale, this._minScale), this._maxScale);
		this.animateToTarget(this._targetPosition, this._targetScale);
	}

	/** Set position immediately (no animation) */
	public setPositionImmediate(pos: Vector2): void {
		this.cancelAnimation();
		this._position = pos;
		this._targetPosition = pos;
		this.applyTransform();
	}

	/** Set scale immediately (no animation) */
	public setScaleImmediate(scale: number): void {
		this.cancelAnimation();
		scale = Math.min(Math.max(scale, this._minScale), this._maxScale);
		this._scale = scale;
		this._targetScale = scale;
		this.updateSmallScaleClass();
		this.applyTransform();
	}

	/** Scale around a point (for pinch/wheel zoom) - immediate */
	public scaleAroundImmediate(scaleBy: number, point: Vector2): void {
		this.cancelAnimation();
		const currentScale = this._scale;
		let newScale = currentScale * scaleBy;
		newScale = Math.min(Math.max(newScale, this._minScale), this._maxScale);
		scaleBy = newScale / currentScale;

		const centerToPoint = point.sub(this._position);
		const centerPin = centerToPoint.scale(scaleBy).add(this._position);
		const offset = point.sub(centerPin);

		this._scale = newScale;
		this._targetScale = newScale;
		this._position = this._position.add(offset);
		this._targetPosition = this._position;

		this.updateSmallScaleClass();
		this.applyTransform();
	}

	/** Fit view to bounds immediately */
	public fitToView(bounds: Bounds, scaleMultiplier: number = SCALE_MULTIPLIER_DEFAULT): void {
		this.refreshWrapperRect();
		const width = this._wrapperRect?.width ?? this.document.containerEl.clientWidth;
		const height = this._wrapperRect?.height ?? this.document.containerEl.clientHeight;

		const xRatio = width / bounds.width;
		const yRatio = height / bounds.height;
		let scale = scaleMultiplier * Math.min(xRatio, yRatio);
		scale = Math.max(this._minScale, Math.min(this._maxScale, scale));

		const screenCenter = new Vector2(width / 2, height / 2);
		const targetPos = screenCenter.sub(bounds.center.scale(scale));

		this.setScaleImmediate(scale);
		this.setPositionImmediate(targetPos);
	}

	/** Animate to view bounds (smooth transition) - used for double-click */
	public animateToView(bounds: Bounds, scaleMultiplier: number = SCALE_MULTIPLIER_DEFAULT): void {
		this.refreshWrapperRect();
		const width = this._wrapperRect?.width ?? this.document.containerEl.clientWidth;
		const height = this._wrapperRect?.height ?? this.document.containerEl.clientHeight;

		const xRatio = width / bounds.width;
		const yRatio = height / bounds.height;
		let scale = scaleMultiplier * Math.min(xRatio, yRatio);
		scale = Math.max(this._minScale, Math.min(this._maxScale, scale));

		const screenCenter = new Vector2(width / 2, height / 2);
		const targetPos = screenCenter.sub(bounds.center.scale(scale));

		this.setTargetScale(scale);
		this.setTargetPosition(targetPos);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// EVENTS
	// ═══════════════════════════════════════════════════════════════════════

	private initEvents(): void {
		// touch-action and user-select now handled by CSS (.canvas-export-mode)

		const pointers = new Map<number, Vector2>();
		let lastCenter: Vector2 | null = null;
		let lastDistance = 0;

		const getPointerPos = (e: PointerEvent): Vector2 => {
			const rect = this._wrapperRect!;
			return new Vector2(e.clientX - rect.left, e.clientY - rect.top);
		};

		const getCenter = (): Vector2 => {
			const pts = Array.from(pointers.values());
			if (pts.length === 0) return new Vector2(0, 0);
			if (pts.length === 1) return pts[0];
			return pts[0].add(pts[1]).scale(0.5);
		};

		const getDistance = (): number => {
			const pts = Array.from(pointers.values());
			if (pts.length < 2) return 0;
			return Vector2.distance(pts[0], pts[1]);
		};

		this.wrapperEl.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button === 1) return; // Skip middle mouse button

			// Don't capture if clicking on interactive elements (links, buttons, inputs)
			const target = e.target as HTMLElement;
			if (target.closest('a, button, input, textarea, [onclick], [role="button"]')) {
				return; // Let the click through to the element
			}

			this.wrapperEl.setPointerCapture(e.pointerId);
			this.refreshWrapperRect();
			pointers.set(e.pointerId, getPointerPos(e));
			lastCenter = getCenter();
			lastDistance = getDistance();
			this.bumpInteraction();
		});

		this.wrapperEl.addEventListener('pointermove', (e: PointerEvent) => {
			if (!pointers.has(e.pointerId)) return;

			this.refreshWrapperRect();
			pointers.set(e.pointerId, getPointerPos(e));
			const center = getCenter();
			const distance = getDistance();

			// Pan - immediate for responsiveness
			if (lastCenter) {
				const delta = center.sub(lastCenter);
				this._position = this._position.add(delta);
				this._targetPosition = this._position;
			}

			// Pinch zoom
			if (pointers.size >= 2 && lastDistance > 0 && distance > 0) {
				const scaleDelta = distance / lastDistance;
				this.scaleAroundImmediate(scaleDelta, center);
			} else {
				this.applyTransform();
			}

			lastCenter = center;
			lastDistance = distance;
			this.bumpInteraction();
		});

		const onPointerUp = (e: PointerEvent) => {
			pointers.delete(e.pointerId);
			this.wrapperEl.releasePointerCapture(e.pointerId);
			lastCenter = pointers.size > 0 ? getCenter() : null;
			lastDistance = getDistance();
		};

		this.wrapperEl.addEventListener('pointerup', onPointerUp);
		this.wrapperEl.addEventListener('pointercancel', onPointerUp);

		// Wheel zoom - immediate
		this.wrapperEl.addEventListener('wheel', (e: WheelEvent) => {
			this.bumpInteraction();
			this.refreshWrapperRect();
			const scale = 1 - e.deltaY / WHEEL_SCALE_DIVISOR;
			const pos = new Vector2(
				e.clientX - this._wrapperRect!.left,
				e.clientY - this._wrapperRect!.top
			);
			this.scaleAroundImmediate(scale, pos);
		}, { passive: true });
	}

	// ═══════════════════════════════════════════════════════════════════════
	// CLEANUP
	// ═══════════════════════════════════════════════════════════════════════

	public destroy(): void {
		// Clear animation
		this.cancelAnimation();

		// Clear interaction timeout
		if (this._interactionIdleTimeoutId !== null) {
			clearTimeout(this._interactionIdleTimeoutId);
			this._interactionIdleTimeoutId = null;
		}

		// Disconnect resize observer
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = null;
		}

		// Remove scroll listener
		window.removeEventListener("scroll", this._handleRectDirty, { capture: true } as EventListenerOptions);
	}
}
