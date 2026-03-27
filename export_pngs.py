import os
from playwright.sync_api import sync_playwright

def export_flowcharts_to_png():
    html_file = f"file:///{os.path.abspath('pyflowchart_architecture.html').replace('\\\\', '/')}"
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        print(f"Loading {html_file}...")
        page.goto(html_file, wait_until="networkidle")
        
        # Find all the canvas divs
        divs = page.query_selector_all('div[id^="canvas_"]')
        
        output_dir = "flowchart_pngs"
        os.makedirs(output_dir, exist_ok=True)
        
        for div in divs:
            div_id = div.get_attribute("id")
            func_name = div_id.replace("canvas_", "")
            
            # Extract SVG element to make sure it's fully rendered
            svg = div.query_selector("svg")
            if svg:
                output_path = os.path.join(output_dir, f"{func_name}.png")
                # Add some padding to the screenshot
                div.screenshot(path=output_path)
                print(f"Exported: {output_path}")
            else:
                print(f"Warning: No SVG found in {div_id}, skipping.")
                
        browser.close()
        print("All flowcharts exported successfully!")

if __name__ == "__main__":
    export_flowcharts_to_png()
