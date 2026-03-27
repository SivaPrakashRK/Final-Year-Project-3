import os
import subprocess

def run_pyflowchart(func_name, title):
    try:
        # Run pyflowchart to extract the specific function's logic
        result = subprocess.run(['python', '-m', 'pyflowchart', 'app.py', '-f', func_name], 
                                capture_output=True, text=True, check=True)
        dsl = result.stdout
        
        # Clean up any problematic characters for JS template literals
        dsl_clean = dsl.replace('`', '\\`')
        
        return f"""
    <h2>{title} (<code>{func_name}</code>)</h2>
    <div id="canvas_{func_name}"></div>
    <script>
      try {{
          var diagram_{func_name} = flowchart.parse(`{dsl_clean}`);
          diagram_{func_name}.drawSVG('canvas_{func_name}', {{
              'x': 0, 'y': 0, 'line-width': 2, 'line-length': 50,
              'text-margin': 10, 'font-size': 12, 'font': 'normal',
              'font-family': 'sans-serif', 'font-weight': 'normal',
              'font-color': 'black', 'line-color': 'black',
              'element-color': 'black', 'fill': 'white',
              'yes-text': 'yes', 'no-text': 'no', 'arrow-end': 'block', 'scale': 1
          }});
      }} catch(err) {{
          console.error("Error drawing {func_name}:", err);
          document.getElementById('canvas_{func_name}').innerHTML = "<p style='color:red;'>Error charting this function: " + err.message + "</p><pre>" + `{dsl_clean}` + "</pre>";
      }}
    </script>
        """
    except Exception as e:
        return f"<h2>Error parsing {func_name}</h2><p>{str(e)}</p>"

def main():
    html_start = '''<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Cognitive Canvas - PyFlowchart Diagrams</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/raphael/2.3.0/raphael.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/flowchart/1.18.0/flowchart.min.js"></script>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #f4f4f9; color: #333; }
      h1 { border-bottom: 2px solid #ccc; padding-bottom: 0.5rem; }
      h2 { margin-top: 3rem; color: #2c3e50; }
      div[id^="canvas"] { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); margin-bottom: 2rem; overflow-x: auto; min-width: 800px; }
      .container { max-width: 1200px; margin: 0 auto; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>PyFlowchart Workflows - Cognitive Canvas</h1>
      <p>These flowcharts were generated directly from the python source code of <code>app.py</code> using the <strong>pyflowchart</strong> library.</p>
'''
    html_end = '''    </div>
  </body>
</html>'''

    print("Generating flowchart DSL for key functions inside app.py...")
    
    content = html_start
    content += run_pyflowchart('analyze_thought', 'Phase 1: Entry Analysis')
    content += run_pyflowchart('save_thought', 'Phase 2: Save and Commit')
    content += run_pyflowchart('process_graph_and_guard', 'Sub-workflow: Link Logic & Rumination Guard')
    content += run_pyflowchart('check_rumination', 'Sub-workflow: Rumination Checks')
    content += html_end

    output_path = 'pyflowchart_architecture.html'
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)
        
    print(f"Interactive PyFlowchart HTML generated successfully at: {output_path}")

if __name__ == '__main__':
    main()
