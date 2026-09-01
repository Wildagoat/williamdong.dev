FeatureScript 3070;
import(path : "onshape/std/geometry.fs", version : "3070.0");

annotation { "Feature Type Name" : "Cycloidal Path", "Feature Type Description" : "" }
export const myFeature = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        // Path Editors
            annotation { "Name" : "Base Circle diameter (d)" }
            isLength(definition.d, LENGTH_BOUNDS);

            annotation { "Name" : "Rolling circle diameter (delta)" }
            isLength(definition.delta, LENGTH_BOUNDS);

            annotation { "Name" : "Eccentricity (e)" }
            isLength(definition.e, LENGTH_BOUNDS);
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

        const d     = definition.d;
        const delta = definition.delta;
        const e     = definition.e;
        const ratio = d / delta;

        const bore = definition.bore;
        const holeCount = definition.hc;
        const dl = definition.dl + 2 * e; // hole must be the diameter and 2 times eccentricity
        const dp = definition.dp;
        // Path definer
        var points = [];
        for (var i = 0; i < 50; i += 1) //50 is the amount of control point
        {
            const phi = (2 * PI * i / 50) * radian;
            const x = (d + delta) / 2 * sin(phi) - e * sin(phi + ratio * phi);
            const y = (d + delta) / 2 * cos(phi) - e * cos(phi + ratio * phi);
            points = append(points, vector(x, y));
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
