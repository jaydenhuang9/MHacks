const TOOL_URL = "map.html";


// -----------------------------------------------------
// 2. HELPER
// -----------------------------------------------------

const $ = selector => document.querySelector(selector);


// -----------------------------------------------------
// 3. OPEN FLUX TOOL BUTTONS
// -----------------------------------------------------

document.querySelectorAll("[data-tool]").forEach(button => {

    button.href = TOOL_URL;

    button.addEventListener("click", event => {

        // If we haven't connected the homepage
        // to the actual tool yet...

        if (TOOL_URL === "#") {

            event.preventDefault();

            const toast = $("#toast");

            toast.classList.add("on");

            setTimeout(() => {
                toast.classList.remove("on");
            }, 2200);

        }

    });

});


// -----------------------------------------------------
// 4. SCROLL ANIMATIONS
// -----------------------------------------------------

const reducedMotion =
    window.matchMedia(
        "(prefers-reduced-motion: reduce)"
    ).matches;


if (!reducedMotion) {

    const observer =
        new IntersectionObserver(
            entries => {

                entries.forEach(entry => {

                    if (entry.isIntersecting) {

                        entry.target.classList.add("in");

                    }

                });

            },
            {
                threshold: 0.12
            }
        );


    document
        .querySelectorAll(".rv")
        .forEach(element => {

            observer.observe(element);

        });

}


// -----------------------------------------------------
// 5. FAQ ACCORDION
// -----------------------------------------------------

document
    .querySelectorAll(".q button")
    .forEach(button => {

        button.addEventListener("click", () => {

            const question =
                button.parentNode;

            question.classList.toggle("o");

        });

    });


// -----------------------------------------------------
// 6. NAVIGATION
// -----------------------------------------------------

document
    .querySelectorAll('.nav a[href^="#"]')
    .forEach(link => {

        link.addEventListener("click", event => {

            const targetID =
                link.getAttribute("href");

            if (targetID === "#") {
                return;
            }

            const target =
                document.querySelector(targetID);

            if (!target) {
                return;
            }

            event.preventDefault();

            target.scrollIntoView({
                behavior: reducedMotion
                    ? "auto"
                    : "smooth"
            });

        });

    });


// -----------------------------------------------------
// 7. CONSOLE MESSAGE
// -----------------------------------------------------

console.log(
    "FLUX homepage loaded successfully."
);