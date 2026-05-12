'use client';

/**
 * Lean Gravity playground — adapted from danielpetho/gravity (21st.dev).
 * Uses matter-js for physics, no framer-motion, no lodash, no svg-path-commander.
 * Bodies are rectangle or circle only (drag-friendly, awwwards-grade).
 *
 * Wrap children in <MatterBody> with x/y as % strings to seed initial positions.
 */
import {
  createContext,
  forwardRef,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import Matter, {
  Bodies,
  Body,
  Common,
  Engine,
  Events,
  Mouse,
  MouseConstraint,
  Query,
  Render,
  Runner,
  World,
} from 'matter-js';
import polyDecomp from 'poly-decomp';
import { cn } from '@/lib/utils';

// Tiny inline debounce (replaces lodash dependency)
function debounce<T extends (...args: unknown[]) => void>(fn: T, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
  };
  return debounced;
}

function calculatePosition(
  value: number | string | undefined,
  containerSize: number,
  elementSize: number
) {
  if (typeof value === 'string' && value.endsWith('%')) {
    const percentage = parseFloat(value) / 100;
    return containerSize * percentage;
  }
  return typeof value === 'number'
    ? value
    : elementSize - containerSize + elementSize / 2;
}

type GravityProps = {
  children: ReactNode;
  debug?: boolean;
  gravity?: { x: number; y: number };
  resetOnResize?: boolean;
  grabCursor?: boolean;
  addTopWall?: boolean;
  autoStart?: boolean;
  className?: string;
};

type MatterBodyProps = {
  children: ReactNode;
  matterBodyOptions?: Matter.IBodyDefinition;
  isDraggable?: boolean;
  bodyType?: 'rectangle' | 'circle';
  x?: number | string;
  y?: number | string;
  angle?: number;
  className?: string;
};

type PhysicsBody = {
  element: HTMLElement;
  body: Matter.Body;
  props: MatterBodyProps;
};

export type GravityRef = {
  start: () => void;
  stop: () => void;
  reset: () => void;
};

const GravityContext = createContext<{
  registerElement: (
    id: string,
    element: HTMLElement,
    props: MatterBodyProps
  ) => void;
  unregisterElement: (id: string) => void;
} | null>(null);

export const MatterBody = ({
  children,
  className,
  matterBodyOptions = {
    friction: 0.1,
    restitution: 0.1,
    density: 0.001,
    isStatic: false,
  },
  bodyType = 'rectangle',
  isDraggable = true,
  x = 0,
  y = 0,
  angle = 0,
  ...props
}: MatterBodyProps) => {
  const elementRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(Math.random().toString(36).substring(7));
  const context = useContext(GravityContext);

  useEffect(() => {
    if (!elementRef.current || !context) return;
    context.registerElement(idRef.current, elementRef.current, {
      children,
      matterBodyOptions,
      bodyType,
      isDraggable,
      x,
      y,
      angle,
      ...props,
    });
    const id = idRef.current;
    return () => context.unregisterElement(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={elementRef}
      className={cn(
        'absolute',
        className,
        isDraggable && 'pointer-events-none'
      )}
    >
      {children}
    </div>
  );
};

export const Gravity = forwardRef<GravityRef, GravityProps>(
  (
    {
      children,
      debug = false,
      gravity = { x: 0, y: 1 },
      grabCursor = true,
      resetOnResize = true,
      addTopWall = true,
      autoStart = true,
      className,
      ...props
    },
    ref
  ) => {
    const canvas = useRef<HTMLDivElement>(null);
    const engine = useRef(Engine.create());
    const render = useRef<Render | undefined>(undefined);
    const runner = useRef<Runner | undefined>(undefined);
    const bodiesMap = useRef(new Map<string, PhysicsBody>());
    const frameId = useRef<number | undefined>(undefined);
    const mouseConstraint = useRef<Matter.MouseConstraint | undefined>(undefined);
    const mouseDown = useRef(false);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const isRunning = useRef(false);

    const registerElement = useCallback(
      (id: string, element: HTMLElement, p: MatterBodyProps) => {
        if (!canvas.current) return;
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const canvasRect = canvas.current.getBoundingClientRect();
        const angle = (p.angle || 0) * (Math.PI / 180);
        const x = calculatePosition(p.x, canvasRect.width, width);
        const y = calculatePosition(p.y, canvasRect.height, height);

        let body;
        if (p.bodyType === 'circle') {
          const radius = Math.max(width, height) / 2;
          body = Bodies.circle(x, y, radius, {
            ...p.matterBodyOptions,
            angle,
            render: {
              fillStyle: debug ? '#888888' : '#00000000',
              strokeStyle: debug ? '#333333' : '#00000000',
              lineWidth: debug ? 3 : 0,
            },
          });
        } else {
          body = Bodies.rectangle(x, y, width, height, {
            ...p.matterBodyOptions,
            angle,
            // Niente chamfer = squadrato perfetto (Swiss restraint)
            render: {
              fillStyle: debug ? '#888888' : '#00000000',
              strokeStyle: debug ? '#333333' : '#00000000',
              lineWidth: debug ? 3 : 0,
            },
          } as Matter.IChamferableBodyDefinition);
        }

        if (body) {
          World.add(engine.current.world, [body]);
          bodiesMap.current.set(id, { element, body, props: p });
        }
      },
      [debug]
    );

    const unregisterElement = useCallback((id: string) => {
      const phys = bodiesMap.current.get(id);
      if (phys) {
        World.remove(engine.current.world, phys.body);
        bodiesMap.current.delete(id);
      }
    }, []);

    const updateElements = useCallback(() => {
      bodiesMap.current.forEach(({ element, body }) => {
        const { x, y } = body.position;
        const rotation = body.angle * (180 / Math.PI);
        element.style.transform = `translate(${
          x - element.offsetWidth / 2
        }px, ${y - element.offsetHeight / 2}px) rotate(${rotation}deg)`;
      });
      frameId.current = requestAnimationFrame(updateElements);
    }, []);

    const initializeRenderer = useCallback(() => {
      if (!canvas.current) return;
      const height = canvas.current.offsetHeight;
      const width = canvas.current.offsetWidth;

      // Required for concave shapes (defensive even if we only use rect/circle).
      Common.setDecomp(polyDecomp);

      engine.current.gravity.x = gravity.x;
      engine.current.gravity.y = gravity.y;

      render.current = Render.create({
        element: canvas.current,
        engine: engine.current,
        options: {
          width,
          height,
          wireframes: false,
          background: '#00000000',
          pixelRatio: window.devicePixelRatio || 1,
        },
      });

      const mouse = Mouse.create(render.current.canvas);
      mouseConstraint.current = MouseConstraint.create(engine.current, {
        mouse,
        constraint: { stiffness: 0.2, render: { visible: debug } },
      });

      const walls = [
        Bodies.rectangle(width / 2, height + 10, width, 20, {
          isStatic: true,
          friction: 1,
          render: { visible: debug },
        }),
        Bodies.rectangle(width + 10, height / 2, 20, height, {
          isStatic: true,
          friction: 1,
          render: { visible: debug },
        }),
        Bodies.rectangle(-10, height / 2, 20, height, {
          isStatic: true,
          friction: 1,
          render: { visible: debug },
        }),
      ];
      if (addTopWall) {
        walls.push(
          Bodies.rectangle(width / 2, -10, width, 20, {
            isStatic: true,
            friction: 1,
            render: { visible: debug },
          })
        );
      }

      const touchingMouse = () =>
        Query.point(
          engine.current.world.bodies,
          mouseConstraint.current?.mouse.position || { x: 0, y: 0 }
        ).length > 0;

      if (grabCursor) {
        Events.on(engine.current, 'beforeUpdate', () => {
          if (!canvas.current) return;
          if (!mouseDown.current && !touchingMouse()) {
            canvas.current.style.cursor = 'default';
          } else if (touchingMouse()) {
            canvas.current.style.cursor = mouseDown.current ? 'grabbing' : 'grab';
          }
        });
        canvas.current.addEventListener('mousedown', () => {
          mouseDown.current = true;
          if (canvas.current && touchingMouse()) {
            canvas.current.style.cursor = 'grabbing';
          }
        });
        canvas.current.addEventListener('mouseup', () => {
          mouseDown.current = false;
          if (canvas.current) {
            canvas.current.style.cursor = touchingMouse() ? 'grab' : 'default';
          }
        });
      }

      World.add(engine.current.world, [mouseConstraint.current, ...walls]);
      render.current.mouse = mouse;

      runner.current = Runner.create();
      Render.run(render.current);
      updateElements();
      runner.current.enabled = false;

      if (autoStart) {
        runner.current.enabled = true;
        startEngine();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [updateElements, debug, autoStart]);

    const clearRenderer = useCallback(() => {
      if (frameId.current) cancelAnimationFrame(frameId.current);
      if (mouseConstraint.current) {
        World.remove(engine.current.world, mouseConstraint.current);
      }
      if (render.current) {
        Mouse.clearSourceEvents(render.current.mouse);
        Render.stop(render.current);
        render.current.canvas.remove();
      }
      if (runner.current) Runner.stop(runner.current);
      if (engine.current) {
        World.clear(engine.current.world, false);
        Engine.clear(engine.current);
      }
      bodiesMap.current.clear();
    }, []);

    const handleResize = useCallback(() => {
      if (!canvas.current || !resetOnResize) return;
      const newWidth = canvas.current.offsetWidth;
      const newHeight = canvas.current.offsetHeight;
      setCanvasSize({ width: newWidth, height: newHeight });
      clearRenderer();
      initializeRenderer();
    }, [clearRenderer, initializeRenderer, resetOnResize]);

    const startEngine = useCallback(() => {
      if (runner.current) {
        runner.current.enabled = true;
        Runner.run(runner.current, engine.current);
      }
      if (render.current) Render.run(render.current);
      frameId.current = requestAnimationFrame(updateElements);
      isRunning.current = true;
    }, [updateElements]);

    const stopEngine = useCallback(() => {
      if (!isRunning.current) return;
      if (runner.current) Runner.stop(runner.current);
      if (render.current) Render.stop(render.current);
      if (frameId.current) cancelAnimationFrame(frameId.current);
      isRunning.current = false;
    }, []);

    const reset = useCallback(() => {
      // Don't destroy/recreate the world — just reposition each body to its
      // initial spot and zero velocities. Then ensure the engine is running
      // so the items fall again.
      const canvasEl = canvas.current;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      bodiesMap.current.forEach(({ element, body, props: p }) => {
        const x = calculatePosition(p.x, rect.width, element.offsetWidth);
        const y = calculatePosition(p.y, rect.height, element.offsetHeight);
        const angle = (p.angle || 0) * (Math.PI / 180);
        Body.setPosition(body, { x, y });
        Body.setVelocity(body, { x: 0, y: 0 });
        Body.setAngularVelocity(body, 0);
        Body.setAngle(body, angle);
      });
      // Restart engine if currently stopped (post-IO trigger or post-reset)
      if (!isRunning.current) {
        startEngine();
      }
    }, [startEngine]);

    useImperativeHandle(
      ref,
      () => ({ start: startEngine, stop: stopEngine, reset }),
      [startEngine, stopEngine, reset]
    );

    useEffect(() => {
      if (!resetOnResize) return;
      const debouncedResize = debounce(handleResize, 500);
      window.addEventListener('resize', debouncedResize);
      return () => {
        window.removeEventListener('resize', debouncedResize);
        debouncedResize.cancel();
      };
    }, [handleResize, resetOnResize]);

    useEffect(() => {
      initializeRenderer();
      return clearRenderer;
    }, [initializeRenderer, clearRenderer]);

    return (
      <GravityContext.Provider value={{ registerElement, unregisterElement }}>
        <div
          ref={canvas}
          className={cn(className, 'absolute top-0 left-0 w-full h-full')}
          {...props}
        >
          {children}
        </div>
      </GravityContext.Provider>
    );
  }
);

Gravity.displayName = 'Gravity';
