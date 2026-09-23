# opus 5.5 test
Build a browser-based first-person 3D exploration game inspired by the concept of a walkable ASCII cyberpunk city.
The implementation must be original. Do not copy source code from an existing project.
The final result must be a playable real-time 3D city rendered primarily as ASCII characters.
Output contract
Produce a complete runnable implementation.
The preferred final deliverable is:
`index.html`
It must be self-contained and include all required HTML, CSS, and JavaScript.
Opening `index.html` in a modern desktop browser must start the application without:

* installing dependencies
* running npm
* using a build system
* starting a server
* downloading external libraries
* using external assets

Do not return only a mockup, architecture description, pseudocode, partial implementation, or code fragments.
The final output must be functional.
If you have access to filesystem or coding tools, create the file directly and test it.
If you do not have access to tools, output the complete contents of `index.html`.
Core concept
Create a custom lightweight 3D renderer in JavaScript using HTML5 Canvas.
Do not use:

* Three.js
* Babylon.js
* Unity
* Unreal Engine
* external game engines
* external rendering libraries
* pre-rendered 3D scenes

The visible world must be rendered using monospace ASCII characters.
The ASCII representation must be part of the rendering pipeline rather than merely decorative text placed over a conventional game.
The renderer should determine visible geometry, depth, materials, lighting, and occlusion and convert those results into characters.
For example, different brightness levels can map to a density ramp similar to:
`.,:;irsXA253hMHGS#9B&@`
You may choose a better ramp if appropriate.
Rendering architecture
Use a grid-based or voxel-like world representation suitable for efficient traversal.
Use raycasting, DDA traversal, software rasterization, or a comparable CPU-side rendering technique.
For each visible sample or ASCII cell, calculate enough information to represent:

* geometry
* distance
* occlusion
* surface type
* approximate lighting
* fog or atmospheric attenuation

Map that information to:

* an ASCII character
* foreground color
* optional brightness

Do not render a conventional textured 3D image and then simply apply an ASCII post-processing filter.
The characters themselves should visually construct the environment.
Use a fixed-width monospace font.
The final frame should look like a terminal displaying a three-dimensional world.
Camera
Implement a first-person camera with:

* perspective
* horizontal rotation
* vertical look
* walking
* strafing
* sprinting
* collision

Controls:

* W = forward
* S = backward
* A = strafe left
* D = strafe right
* Mouse = look
* Shift = sprint
* E = interact
* Esc = release mouse pointer

Use Pointer Lock when appropriate.
Movement should feel smooth rather than grid-locked.
World
Start with a compact but detailed playable city area.
The minimum world should contain:

* at least 4 buildings
* streets
* sidewalks
* one intersection
* alleys or narrow spaces
* street lights
* neon signs
* environmental props
* trees or comparable street vegetation
* parked vehicles
* moving vehicles
* pedestrians

Buildings should vary in:

* height
* footprint
* facade
* windows
* signage
* lighting

Avoid making every building a simple identical rectangular block.
Interiors
At least one building must be enterable.
The player must be able to walk from the street into the building without loading a separate page.
The interior should contain recognizable geometry such as:

* walls
* floor
* ceiling
* doorway
* furniture or props
* lighting

Use the same ASCII rendering system indoors.
Dynamic entities
Implement simple entities such as pedestrians and cars.
Pedestrians should:

* move through the environment
* follow simple destinations or paths
* stop or turn when necessary
* have slight behavioral variation

Cars should:

* move primarily along roads
* follow predefined or generated routes
* stop, turn, or loop when appropriate

Complex AI is not required.
The purpose is to make the city feel inhabited.
Interaction
Use `E` as a general interaction key.
At minimum, include one meaningful interaction.
Examples include:

* opening a door
* talking to an NPC
* activating a terminal
* reading a sign
* buying an item
* entering a shop

Display contextual interaction text when the player is close enough to an interactive object.
Procedural generation
Represent the world primarily as data rather than hard-coded drawing commands.
Where practical, procedurally generate:

* building dimensions
* window layouts
* signs
* facade details
* rooftop structures
* props
* lighting variation

Use a deterministic random seed so the same seed produces the same city.
Keep the generation system simple enough to understand and extend.
Visual style
Use a dark cyberpunk terminal aesthetic.
The primary presentation should be monochrome or near-monochrome ASCII with restrained accent colors.
Good uses of accent color include:

* neon signs
* traffic lights
* windows
* interactive objects
* vehicles
* HUD elements

The result should include:

* clearly visible ASCII characters
* strong depth perception
* dark streets
* bright localized lights
* atmospheric distance fog
* distant geometry fading into sparse characters
* illuminated windows
* animated signs
* subtle flicker
* slight character variation
* a strong sense of movement while walking

Avoid excessive visual effects that make the characters difficult to read.
Lighting
Implement an inexpensive lighting approximation.
At minimum, account for:

* surface brightness
* distance
* ambient darkness
* local lights
* emissive objects such as neon signs

Street lamps and neon signs should visibly affect nearby surfaces if feasible.
Lighting does not need to be physically correct.
It should primarily improve depth perception and atmosphere.
HUD
Add a small ASCII-style HUD that displays:

* FPS
* player coordinates
* current district or block
* control hints
* interaction prompts when relevant

Keep the HUD visually consistent with the terminal aesthetic.
Performance
Target smooth real-time rendering on a modern desktop browser.
Aim for approximately 60 FPS where practical.
Do not test every ray against every world object.
Use spatial organization such as:

* occupancy grids
* tiles
* cells
* DDA traversal
* nearby-object lists

Avoid unnecessary allocations inside the main rendering loop.
Reuse arrays and data structures where useful.
Adjust internal rendering resolution independently from the browser window resolution if necessary.
For example, the world may be rendered to a grid of approximately:

* 120 × 45 characters
* 160 × 60 characters

and then scaled to fit the display.
Choose a resolution that balances visual quality and performance.
Internal architecture
Even though the project is contained in one HTML file, keep the JavaScript logically separated.
Use clearly identifiable sections or classes for:

1. configuration
2. utility functions
3. seeded random generation
4. world representation
5. procedural city generation
6. player and camera
7. collision
8. raycasting or visibility
9. lighting
10. ASCII rendering
11. entity system
12. pedestrian behavior
13. vehicle behavior
14. interactions
15. input handling
16. HUD
17. game loop

Do not create unnecessary abstractions.
Prefer readable code over excessive architecture.
Implementation order
Build the application in this order:

1. Create the Canvas and ASCII display.
2. Implement player movement and mouse look.
3. Create a simple world representation.
4. Implement the 3D visibility/raycasting system.
5. Convert the rendered scene to ASCII.
6. Add depth and lighting.
7. Add streets and buildings.
8. Add collision.
9. Add procedural building variation.
10. Add environmental props and signs.
11. Add pedestrians.
12. Add vehicles.
13. Add an enterable interior.
14. Add interaction.
15. Add atmospheric effects.
16. Optimize performance.
17. Test the complete game.

Do not spend substantial effort on NPC behavior, procedural generation, or content before the core renderer is working correctly.
The renderer and movement are the highest priority.
Acceptance criteria
The task is complete only if all of the following are true:

* The application launches from one HTML file.
* No external dependencies are required.
* The user can walk around using WASD.
* Mouse movement controls the camera.
* The scene has convincing three-dimensional perspective.
* Buildings correctly occlude objects behind them.
* Nearby objects appear larger than distant objects.
* The world is visibly constructed from ASCII characters.
* Streets and multiple buildings are visible.
* Collision prevents walking directly through solid buildings.
* At least one pedestrian moves.
* At least one vehicle moves.
* At least one building can be entered.
* At least one object or NPC can be interacted with.
* Depth or distance changes character density or brightness.
* Lighting affects the appearance of the scene.
* A HUD displays FPS and player position.
* The game remains playable at interactive frame rates.

Quality priorities
When trade-offs are necessary, prioritize in this order:

1. convincing ASCII 3D rendering
2. responsive movement and camera
3. spatial depth and atmosphere
4. stable performance
5. interesting city geometry
6. interactions
7. NPC complexity
8. content quantity

A small city that looks excellent and feels good to explore is better than a huge city with a weak renderer.
Failure modes to avoid
Do not:

* substitute normal pixel graphics for ASCII
* create only a fake 2D terminal interface
* make a static ASCII image
* create a conventional top-down roguelike
* use CSS 3D transforms as the primary rendering technique
* use an external 3D engine
* use external assets
* build a huge procedural city before the renderer works
* return pseudocode instead of the working implementation
* omit collision
* omit mouse look
* stop after implementing only the first development stage

Final verification
Before considering the task finished, verify:

1. The HTML contains no required external resources.
2. There are no JavaScript errors during normal play.
3. Movement and mouse look work.
4. Collision works.
5. The player cannot leave the intended playable area accidentally.
6. Moving entities continue functioning while the player explores.
7. Entering and leaving the interior works.
8. Resizing the browser does not break the renderer.
9. Performance remains reasonable while looking toward the densest part of the city.
10. The result clearly reads as a walkable 3D ASCII cyberpunk city.

Fix any issues found during verification before producing the final result.
