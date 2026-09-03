FeatureScript 3070;
import(path : "onshape/std/geometry.fs", version : "3070.0");

// Sensible range for the roller count (disk lobe count is N - 1).
const ROLLER_COUNT_BOUNDS = { (unitless) : [3, 11, 500] } as IntegerBoundSpec;

annotation { "Feature Type Name" : "Cycloidal Path", "Feature Type Description" : "" }
export const myFeature = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        // ---- Cycloidal disk PROFILE parameters (see "parametric equation cycloidal disc") ----
            annotation { "Name" : "Roller pitch circle diameter (D)" }
            isLength(definition.D, LENGTH_BOUNDS);

            annotation { "Name" : "Roller diameter (dr)" }
            isLength(definition.dr, LENGTH_BOUNDS);

            annotation { "Name" : "Number of rollers (N)" }
            isInteger(definition.N, ROLLER_COUNT_BOUNDS);

            annotation { "Name" : "Eccentricity (e)" }
            isLength(definition.e, LENGTH_BOUNDS);

        // ---- LEGACY inputs for the old pin-CENTRE reference path (kept for reference) ----
        // The original feature traced the roller-centre path from a base circle (d) and a
        // rolling circle (delta); you then dragged the roller diameter along it to get the
        // real contour by hand. The profile equation below derives the finished disk
        // directly, so these two inputs are no longer used.
        //     annotation { "Name" : "Base Circle diameter (d)" }
        //     isLength(definition.d, LENGTH_BOUNDS);
        //
        //     annotation { "Name" : "Rolling circle diameter (delta)" }
        //     isLength(definition.delta, LENGTH_BOUNDS);
        // --------------------------------------------------------------

            annotation { "Name" : "Load Pin diameter (dl) " }
            isLength(definition.dl, LENGTH_BOUNDS);

            annotation { "Name" : "Hole Count" }
            isInteger(definition.hc, POSITIVE_COUNT_BOUNDS);

            annotation { "Name" : "Load Holes Pitch diameter (dp)" }
            isLength(definition.dp, LENGTH_BOUNDS);

            annotation { "Name" : "Center Bore" }
            isLength(definition.bore, LENGTH_BOUNDS);

            annotation { "Name" : "depth" }
            isLength(definition.depth, LENGTH_BOUNDS);
    }
    {

        const sketchPlane = plane(WORLD_ORIGIN, Z_DIRECTION, X_DIRECTION);
        var sketch = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : sketchPlane });

        // ---- Profile inputs (image: "parametric equation cycloidal disc") ----
        const D  = definition.D;   // roller pitch circle diameter
        const dr = definition.dr;  // roller diameter
        const N  = definition.N;   // number of rollers  (disk has n = N - 1 lobes)
        const e  = definition.e;   // eccentricity

        // ---- LEGACY inputs (only referenced by the commented-out path below) ----
        // const d     = definition.d;
        // const delta = definition.delta;
        // const ratio = d / delta;

        const bore = definition.bore;
        const holeCount = definition.hc;
        const dl = definition.dl + 2 * e; // hole must be the diameter and 2 times eccentricity
        const dp = definition.dp;

        // ================= Cycloidal disk PROFILE =================
        // True disk contour that meshes with N rollers of diameter dr on a pitch circle of
        // diameter D, with eccentricity e (the disk has n = N - 1 lobes):
        //
        //   gamma = atan2( sin((N-1) phi),  cos((N-1) phi) - D / (2 e N) )
        //   x =  D/2 cos(phi) - dr/2 cos(phi + gamma) - e cos(N phi)
        //   y = -D/2 sin(phi) + dr/2 sin(phi + gamma) + e sin(N phi)
        //
        // The reference writes gamma as tan^-1(...). We evaluate it with atan2(num, den) so
        // the angle stays in the correct quadrant when the denominator goes negative — the
        // single-argument arctangent would flip the contour over part of the revolution.

        // Path definer
        const steps = max(200, 40 * (N - 1)); // enough samples to resolve every lobe cleanly
        var points = [];
        for (var i = 0; i < steps; i += 1)
        {
            const phi = (2 * PI * i / steps) * radian;

            const gamma = atan2(sin((N - 1) * phi),
                                cos((N - 1) * phi) - D / (2 * e * N));

            const x =  D / 2 * cos(phi) - dr / 2 * cos(phi + gamma) - e * cos(N * phi);
            const y = -D / 2 * sin(phi) + dr / 2 * sin(phi + gamma) + e * sin(N * phi);

            points = append(points, vector(x, y));

            // ---- ORIGINAL pin-CENTRE reference path (superseded by the profile above) ----
            // const xOld = (d + delta) / 2 * sin(phi) - e * sin(phi + ratio * phi);
            // const yOld = (d + delta) / 2 * cos(phi) - e * cos(phi + ratio * phi);
            // points = append(points, vector(xOld, yOld));
        }
        points = append( points, points[0]);

        skFitSpline(sketch, "cycloid", {
                "points" : points,
                "isPeriodic" : true
        });
        //-----------------------------------------------

        //center bore
        skCircle(sketch, "bore", {
                "center" : vector(0, 0) * meter,
                "radius" : bore / 2
        });

        // circle pattern logic for loadpins
        for (var i = 0; i < holeCount; i += 1)
        {
            const ang = (2 * PI * i / holeCount) * radian;
            const c = vector(dp/2 * cos(ang), dp/2 * sin(ang));
            skCircle(sketch, "hole" ~ i, { "center" : c, "radius" : dl/2 });
        }

        skSolve(sketch);

        opExtrude(context, id + "disc", {
        "entities" : qSketchRegion(id + "sketch", true),
        "direction" : Z_DIRECTION,
        "endBound" : BoundingType.BLIND,
        "endDepth" : definition.depth
});
    });
